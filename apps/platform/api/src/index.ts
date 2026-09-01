/**
 * Postey dashboard worker: session-authenticated API + the dashboard SPA
 * assets. The public send API is a separate worker (send); this one never
 * accepts API keys - only browser sessions.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Bindings, Variables } from './types';
import {
  claim,
  createSession,
  destroySession,
  isClaimed,
  requireAuth,
  sessionUser,
  verifyPassword,
} from './lib/auth';
import { resourcesRoute } from './routes/resources';
import { messagesRoute } from './routes/messages';
import { inboxRoute } from './routes/inbox';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.get('/', c => c.json({ name: 'postey-api', status: 'ok' }));
app.get('/health', c => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/health', c => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

/* Login-page switch: first-run claim screen vs sign-in. Mirrors Traks: says
 * nothing about who may claim; the code is enforced server-side only. */
app.get('/api/claim-status', async c => {
  const claimed = await isClaimed(c.env);
  return c.json({ claimed, needsCode: !claimed && Boolean(c.env.CLAIM_TOKEN) });
});

app.get('/api/config', c =>
  c.json({
    sendUrl: c.env.SEND_URL ?? null,
    sendingDomain: c.env.SENDING_DOMAIN ?? null,
    version: c.env.POSTEY_VERSION ?? null,
    deployInstanceId: c.env.DEPLOY_INSTANCE_ID ?? null,
  })
);

/* ── auth ────────────────────────────────────────────────────────── */

app.post(
  '/api/auth/claim',
  zValidator(
    'json',
    z.object({
      code: z.string().max(128).optional(),
      email: z.string().email(),
      password: z.string().min(1).max(256),
    })
  ),
  async c => {
    const result = await claim(c, c.req.valid('json'));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ data: { ok: true } });
  }
);

app.post(
  '/api/auth/login',
  zValidator('json', z.object({ email: z.string().email(), password: z.string().max(256) })),
  async c => {
    const { email, password } = c.req.valid('json');
    const user = await c.env.DB.prepare(
      'SELECT id, password_hash FROM users WHERE email = ?'
    )
      .bind(email.toLowerCase())
      .first<{ id: string; password_hash: string }>();
    // Same error either way - never reveal which half was wrong.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }
    await createSession(c, user.id);
    return c.json({ data: { ok: true } });
  }
);

app.post('/api/auth/logout', async c => {
  await destroySession(c);
  return c.json({ data: { ok: true } });
});

app.get('/api/me', async c => {
  const user = await sessionUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ data: user });
});

/* ── authenticated dashboard API ─────────────────────────────────── */

app.use('/api/*', requireAuth);
const routes = app.route('/api', messagesRoute).route('/api', resourcesRoute).route('/api', inboxRoute);

/* Unmatched non-API paths are SPA routes: serve the assets fallback. */
app.notFound(c => {
  if (!c.req.path.startsWith('/api/') && c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ error: 'Not found' }, 404);
});
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export type AppType = typeof routes;

export default { fetch: app.fetch };
