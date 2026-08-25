/**
 * Single-operator auth: PBKDF2 password hashes, DB-backed sessions, and the
 * claim flow that secures the first sign-up on a freshly provisioned instance
 * (predictable workers.dev hostnames must not be claimable by whoever finds
 * them first - the wizard mints CLAIM_TOKEN and hands it to the deployer).
 */
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { newId, randomHex } from '@postey/shared';
import type { Bindings, Variables, SessionUser } from '../types';

const SESSION_COOKIE = 'postey_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const PBKDF2_ITERATIONS = 100_000;

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${hex(salt)}$${hex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const salt = fromHex(saltHex);
  const bits = await derive(password, salt, Number(iterStr));
  return timingSafeEqual(hex(new Uint8Array(bits)), hashHex);
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256
  );
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)));

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && x.length > 0;
}

export async function createSession(c: Ctx, userId: string): Promise<void> {
  const id = `ses_${randomHex(24)}`;
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(id, userId, now + SESSION_TTL_MS, now)
    .run();
  setCookie(c, SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    secure: c.env.ENVIRONMENT !== 'development',
    sameSite: 'Lax',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(c: Ctx): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function sessionUser(c: Ctx): Promise<SessionUser | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return null;
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  )
    .bind(id)
    .first<{ id: string; email: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, email: row.email };
}

export async function requireAuth(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
): Promise<Response | void> {
  const user = await sessionUser(c as Ctx);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  c.set('user', user);
  await next();
}

export async function isClaimed(env: Bindings): Promise<boolean> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

export async function claim(
  c: Ctx,
  input: { code?: string; email: string; password: string }
): Promise<{ ok: true } | { ok: false; error: string; status: 400 | 403 | 409 }> {
  if (await isClaimed(c.env)) {
    return { ok: false, error: 'This instance is already claimed. Sign in instead', status: 409 };
  }
  if (c.env.CLAIM_TOKEN && !timingSafeEqual(input.code ?? '', c.env.CLAIM_TOKEN)) {
    return { ok: false, error: 'Invalid claim code', status: 403 };
  }
  if (input.password.length < 10) {
    return { ok: false, error: 'Password must be at least 10 characters', status: 400 };
  }
  const userId = newId('usr');
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(userId, input.email.toLowerCase(), await hashPassword(input.password), Date.now())
    .run();
  await createSession(c, userId);
  return { ok: true };
}
