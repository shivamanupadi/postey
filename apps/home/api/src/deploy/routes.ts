/**
 * Web-installer API (public, unauthenticated - it acts on the CALLER'S
 * Cloudflare account using tokens they supply per request; tokens are never
 * stored, logged, or echoed). Powers the postey.app/deploy wizard.
 */
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { randomHex } from '@postey/shared';
import {
  destroyInstance,
  emptyBucket,
  listAccounts,
  listZones,
  provisionInstance,
  userEmail,
  type DeployArtifacts,
  type StepEvent,
} from './engine';
import type { Bindings, InstanceRow, SendingDomainChoice } from '../types';

/** A live run touches its registry row at least this often. */
const HEARTBEAT_MS = 20_000;
/** A 'deploying' row quieter than this is dead and may be retaken. */
const RUN_STALE_MS = 3 * 60_000;

const app = new Hono<{ Bindings: Bindings }>();

/* ── "Sign in with Cloudflare" (self-managed OAuth client) ─────────────────
 * Same flow as Traks: authorization-code + PKCE; token exchange is
 * client_secret_post. The state nonce + PKCE verifier live in a short-lived
 * HttpOnly cookie (nothing stored server-side), and the access token is
 * handed to the SPA in the URL fragment so it never transits back to us.
 *
 * Scope names must EXACTLY match the scopes registered on the OAuth client -
 * adjust both together when the "Postey Deploy" client is registered.
 */
const CF_OAUTH_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
const CF_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
// Registered on the "Postey Deploy" client (id 667f41400ae511fbf5d1e02e9893ad95).
const CF_OAUTH_SCOPES = [
  'workers-scripts.write',
  'd1.write',
  'workers-r2.write',
  'queues.write',
  'zone.read',
  'dns.read',
  'email-sending.write',
  'account-settings.read',
  'user-details.read',
];
const OAUTH_COOKIE = 'postey_oauth';

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

// Canonicalized to the apex: the OAuth client registers exactly one redirect
// URI, and the SPA is reachable on www too.
const redirectUri = (c: Context): string =>
  `${new URL(c.req.url).origin.replace('://www.', '://')}/deploy/callback`;

/** Top-level GET /deploy/callback (registered redirect URI - outside /api). */
export async function oauthCallback(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  const url = new URL(c.req.url);
  const state = url.searchParams.get('state') ?? '';
  const [instanceId, nonce] = state.split('.');
  const cookie = getCookie(c, OAUTH_COOKIE) ?? '';
  const [cookieNonce, verifier, cookieInstance, cookieFlow] = cookie.split('.');
  // Each flow has its own page - return to whichever one started the sign-in.
  // Server-set cookie only; a missing/old cookie falls back to /deploy.
  const flow = cookieFlow === 'update' || cookieFlow === 'destroy' ? cookieFlow : 'deploy';
  const back = (params: string): Response =>
    c.redirect(`/${flow}?instance=${encodeURIComponent(instanceId ?? '')}${params}`);

  const denied = url.searchParams.get('error');
  if (denied) return back(`&oauth_error=${encodeURIComponent(denied)}`);

  const code = url.searchParams.get('code');
  deleteCookie(c, OAUTH_COOKIE, { path: '/' });
  // The instance id is bound to the cookie, not just carried in `state`:
  // otherwise a crafted start URL could land a victim's completed sign-in on
  // a session row chosen by someone else.
  if (
    !code ||
    !instanceId ||
    !nonce ||
    nonce !== cookieNonce ||
    !verifier ||
    instanceId !== cookieInstance
  ) {
    return back('&oauth_error=state_mismatch');
  }

  const res = await fetch(CF_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(c),
      client_id: c.env.CF_OAUTH_CLIENT_ID ?? '',
      client_secret: c.env.CF_OAUTH_CLIENT_SECRET ?? '',
      code_verifier: verifier,
    }),
  });
  const data = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !data?.access_token) return back('&oauth_error=exchange_failed');
  // Fragment, not query: the token stays in the browser and never reaches us.
  return back(`#cf_token=${encodeURIComponent(data.access_token)}`);
}

const tokenSchema = z.string().min(20).max(2048);
const accountIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const instanceNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{2,20}$/, 'lowercase letters, digits, and dashes');

const startSchema = z.object({
  apiToken: tokenSchema,
  accountId: accountIdSchema,
  instanceName: instanceNameSchema,
  sendingDomain: z.object({
    zoneId: z.string().regex(/^[a-f0-9]{32}$/),
    zoneName: z
      .string()
      .max(253)
      .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i),
    subdomain: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)
      .or(z.literal('')),
  }),
});

const hostnameOf = (d: SendingDomainChoice): string =>
  d.subdomain ? `${d.subdomain}.${d.zoneName}` : d.zoneName;

/* ── registry helpers (raw D1; no ORM) ───────────────────────────── */

async function getRow(db: D1Database, id: string): Promise<InstanceRow | null> {
  return db.prepare('SELECT * FROM deploy_instances WHERE id = ?').bind(id).first<InstanceRow>();
}

async function updateRow(
  db: D1Database,
  id: string,
  fields: Partial<Record<keyof InstanceRow, unknown>>
): Promise<void> {
  const entries = Object.entries({ ...fields, updated_at: Date.now() });
  await db
    .prepare(
      `UPDATE deploy_instances SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`
    )
    .bind(...entries.map(([, v]) => v), id)
    .run();
}

/* ── auth: possession of an id is never sufficient ───────────────── */

async function authorizeRow(
  row: InstanceRow,
  apiToken: string,
  accountId: string,
  instanceName: string
): Promise<string | null> {
  let accounts: { id: string }[];
  try {
    accounts = await listAccounts(apiToken);
  } catch {
    return 'Could not verify the token against Cloudflare';
  }
  if (!accounts.some(a => a.id === accountId)) {
    return 'This token cannot act on the selected Cloudflare account';
  }
  if (row.account_id && row.account_id !== accountId) {
    return 'This deploy session belongs to a different Cloudflare account';
  }
  if (row.instance_name && row.instance_name !== instanceName) {
    return 'This deploy session belongs to a different instance';
  }
  return null;
}

const clientIp = (c: Context): string =>
  c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';

async function limited(
  c: Context<{ Bindings: Bindings }>,
  limiter: Bindings['VERIFY_LIMIT']
): Promise<Response | null> {
  if (!limiter) return null;
  const { success } = await limiter.limit({ key: clientIp(c) });
  return success ? null : c.json({ error: 'Too many requests. Try again shortly' }, 429);
}

/* ── release artifacts ───────────────────────────────────────────── */

async function loadArtifacts(releases: R2Bucket): Promise<DeployArtifacts> {
  const manifestObj = await releases.get('current/manifest.json');
  if (!manifestObj) throw new Error('release artifacts missing. Run installer/upload-release');
  const manifest = (await manifestObj.json()) as {
    version?: string;
    assets: { path: string; hash: string; size: number; contentType: string | null }[];
    migrations: string[];
  };
  const bytes = async (key: string): Promise<Uint8Array> => {
    const obj = await releases.get(key);
    if (!obj) throw new Error(`release artifact missing: ${key}`);
    return new Uint8Array(await obj.arrayBuffer());
  };
  const text = async (key: string): Promise<string> => {
    const obj = await releases.get(key);
    if (!obj) throw new Error(`release artifact missing: ${key}`);
    return obj.text();
  };
  return {
    apiWorker: () => bytes('current/api-worker.js'),
    sendWorker: () => bytes('current/send-worker.js'),
    inboundWorker: () => bytes('current/inbound-worker.js'),
    webAssets: manifest.assets.map(a => ({
      ...a,
      getContent: () => bytes(`current/assets/${a.hash}`),
    })),
    migrations: manifest.migrations.map(name => ({
      name,
      getSql: () => text(`current/migrations/${name}`),
    })),
    version: manifest.version,
  };
}

/* ── SSE plumbing shared by provision and destroy ────────────────── */

function sseStream(
  c: Context<{ Bindings: Bindings }>,
  run: (send: (payload: unknown) => void, heartbeat: () => void) => Promise<void>
): Response {
  const encoder = new TextEncoder();
  let runPromise: Promise<void> = Promise.resolve();
  const stream = new ReadableStream({
    start: controller => {
      let clientGone = false;
      const send = (payload: unknown): void => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          clientGone = true; // keep provisioning; wizard reattaches by polling
        }
      };
      const ping = (): void => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          clientGone = true;
        }
      };
      runPromise = run(send, ping).finally(() => {
        try {
          controller.close();
        } catch {
          /* already cancelled */
        }
      });
    },
  });
  try {
    c.executionCtx.waitUntil(runPromise);
  } catch {
    /* executionCtx unavailable (tests) */
  }
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

/* ── routes ──────────────────────────────────────────────────────── */

export const deployRoute = app
  // Kick off "Sign in with Cloudflare": stash nonce + PKCE verifier in a
  // short-lived cookie and bounce to the dashboard consent screen.
  .get('/oauth/start', async c => {
    if (!c.env.CF_OAUTH_CLIENT_ID) return c.json({ error: 'OAuth not configured' }, 404);
    // The state cookie must live on the host the callback lands on (the apex,
    // the client's one registered redirect URI) - hop off www before starting.
    const url = new URL(c.req.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return c.redirect(url.toString(), 301);
    }
    const instanceId = c.req.query('instance');
    if (!instanceId || !/^[a-zA-Z0-9-]{8,64}$/.test(instanceId)) {
      return c.json({ error: 'instance required' }, 400);
    }
    const flowParam = c.req.query('flow');
    const flow = flowParam === 'update' || flowParam === 'destroy' ? flowParam : 'deploy';
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    );
    setCookie(c, OAUTH_COOKIE, `${nonce}.${verifier}.${instanceId}.${flow}`, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 600,
    });
    const auth = new URL(CF_OAUTH_AUTH_URL);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', c.env.CF_OAUTH_CLIENT_ID);
    auth.searchParams.set('redirect_uri', redirectUri(c));
    auth.searchParams.set('scope', CF_OAUTH_SCOPES.join(' '));
    auth.searchParams.set('state', `${instanceId}.${nonce}`);
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');
    return c.redirect(auth.toString());
  })

  // Create a wizard session.
  .post('/instance', async c => {
    const capped = await limited(c, c.env.SESSION_LIMIT);
    if (capped) return capped;
    const id = randomHex(12);
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO deploy_instances (id, status, created_at, updated_at) VALUES (?, 'new', ?, ?)"
    )
      .bind(id, now, now)
      .run();
    return c.json({ data: { id, status: 'new' } });
  })

  // Resume state for a returning ?instance= visitor. Projected: account id is
  // never echoed and step details are truncated (an instance id is no secret).
  .get('/instance/:id', async c => {
    const row = await getRow(c.env.DB, c.req.param('id'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const steps = (row.steps ? (JSON.parse(row.steps) as StepEvent[]) : []).map(st => ({
      ...st,
      detail: st.detail ? st.detail.slice(0, 300) : st.detail,
    }));
    return c.json({
      data: {
        status: row.status,
        instanceName: row.instance_name,
        apiUrl: row.api_url,
        sendUrl: row.send_url,
        sendingDomain: row.sending_domain ? JSON.parse(row.sending_domain) : null,
        deployedVersion: row.deployed_version,
        error: row.error ? row.error.slice(0, 300) : row.error,
        steps,
        updatedAt: row.updated_at,
      },
    });
  })

  // List the accounts the supplied token can act on (token used once, discarded).
  .post(
    '/instance/:id/accounts',
    zValidator('json', z.object({ apiToken: tokenSchema })),
    async c => {
      const capped = await limited(c, c.env.VERIFY_LIMIT);
      if (capped) return capped;
      const row = await getRow(c.env.DB, c.req.param('id'));
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        const token = c.req.valid('json').apiToken;
        const accounts = await listAccounts(token);
        if (accounts.length === 0) {
          return c.json({ error: 'This token cannot access any Cloudflare account' }, 400);
        }
        const installs = (
          await c.env.DB.prepare(
            `SELECT id, account_id, instance_name, api_url, deployed_version, updated_at
             FROM deploy_instances
             WHERE (status = 'ready' OR (status = 'failed' AND deployed_version IS NOT NULL))
               AND account_id IN (${accounts.map(() => '?').join(',')})`
          )
            .bind(...accounts.map(a => a.id))
            .all<InstanceRow>()
        ).results;
        const byInstance = new Map<string, (typeof installs)[number]>();
        for (const r of installs) {
          const key = `${r.account_id}/${r.instance_name}`;
          const prev = byInstance.get(key);
          if (!prev || r.updated_at > prev.updated_at) byInstance.set(key, r);
        }
        return c.json({
          data: accounts,
          email: await userEmail(token),
          installs: [...byInstance.values()],
        });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'token check failed' }, 400);
      }
    }
  )

  // List the chosen account's zones for the sending-domain picker.
  .post(
    '/instance/:id/zones',
    zValidator('json', z.object({ apiToken: tokenSchema, accountId: accountIdSchema })),
    async c => {
      const capped = await limited(c, c.env.VERIFY_LIMIT);
      if (capped) return capped;
      const row = await getRow(c.env.DB, c.req.param('id'));
      if (!row) return c.json({ error: 'Not found' }, 404);
      const { apiToken, accountId } = c.req.valid('json');
      try {
        return c.json({ data: await listZones(apiToken, accountId) });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'zone list failed' }, 400);
      }
    }
  )

  // Latest published release, for update-available checks (CORS-open: customer
  // instances call this cross-origin).
  .get('/latest-version', async c => {
    const obj = await c.env.RELEASES.get('current/manifest.json');
    if (!obj) return c.json({ error: 'No release published' }, 404);
    const manifest = (await obj.json()) as { version?: string; uploadedAt?: string };
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'public, max-age=300');
    return c.json({ data: { version: manifest.version, uploadedAt: manifest.uploadedAt } });
  })

  // Run the deploy, streaming step events as SSE. Idempotent - a retry after
  // a failure resumes from existing resources.
  .post('/instance/:id/provision', zValidator('json', startSchema), async c => {
    const id = c.req.param('id');
    const row = await getRow(c.env.DB, id);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const staleCutoff = Date.now() - RUN_STALE_MS;
    if (row.status === 'deploying' && row.updated_at > staleCutoff) {
      return c.json({ error: 'Deploy already running' }, 409);
    }

    const { apiToken, accountId, instanceName, sendingDomain } = c.req.valid('json');
    const denied = await authorizeRow(row, apiToken, accountId, instanceName);
    if (denied) return c.json({ error: denied }, 403);

    // Take the run atomically: two tabs racing past the read must not both start.
    const taken = await c.env.DB.prepare(
      `UPDATE deploy_instances SET status = 'deploying', updated_at = ?
       WHERE id = ? AND (status != 'deploying' OR updated_at < ?)`
    )
      .bind(Date.now(), id, staleCutoff)
      .run();
    if (!taken.meta.changes) return c.json({ error: 'Deploy already running' }, 409);

    const artifacts = await loadArtifacts(c.env.RELEASES);
    const db = c.env.DB;
    const steps: StepEvent[] = [];

    return sseStream(c, async (send, ping) => {
      const persist = (
        status: 'deploying' | 'ready' | 'failed',
        extra: Partial<Record<keyof InstanceRow, unknown>> = {}
      ): Promise<void> =>
        updateRow(db, id, {
          status,
          account_id: accountId,
          instance_name: instanceName,
          steps: JSON.stringify(steps),
          ...extra,
        });

      const heartbeat = setInterval(() => {
        ping();
        db.prepare(
          "UPDATE deploy_instances SET updated_at = ? WHERE id = ? AND status = 'deploying'"
        )
          .bind(Date.now(), id)
          .run()
          .catch(() => undefined);
      }, HEARTBEAT_MS);

      try {
        await persist('deploying', {
          error: null,
          sending_domain: JSON.stringify(sendingDomain),
        });
        const result = await provisionInstance({
          apiToken,
          accountId,
          instance: instanceName,
          artifacts,
          sendingDomain: { zoneId: sendingDomain.zoneId, hostname: hostnameOf(sendingDomain) },
          deploySessionId: id,
          randomHex,
          emit: async e => {
            steps.push(e);
            send({ type: 'step', ...e });
            await persist('deploying').catch(() => undefined);
          },
        });
        // The claim code is deliberately NOT persisted - it goes to the
        // user's browser over this stream only.
        await persist('ready', {
          api_url: result.apiUrl,
          send_url: result.sendUrl,
          deployed_version: artifacts.version ?? null,
        });
        send({ type: 'done', ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'deploy failed';
        // A failed UPDATE of a previously shipped instance leaves the old
        // worker serving - the row stays 'ready' with the error recorded.
        await persist(row.deployed_version ? 'ready' : 'failed', { error: message });
        send({ type: 'error', message });
      } finally {
        clearInterval(heartbeat);
      }
    });
  })

  // Tear down an instance, streaming step events as SSE. Idempotent.
  .post(
    '/instance/:id/destroy',
    zValidator(
      'json',
      z.object({
        apiToken: tokenSchema,
        accountId: accountIdSchema,
        instanceName: instanceNameSchema,
        confirmName: z.string().max(64),
      })
    ),
    async c => {
      const id = c.req.param('id');
      const row = await getRow(c.env.DB, id);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const { apiToken, accountId, instanceName, confirmName } = c.req.valid('json');
      if (confirmName !== instanceName) {
        return c.json({ error: 'Confirmation does not match the instance name' }, 400);
      }
      const denied = await authorizeRow(row, apiToken, accountId, instanceName);
      if (denied) return c.json({ error: denied }, 403);

      const db = c.env.DB;
      const steps: StepEvent[] = [];
      return sseStream(c, async send => {
        try {
          const outcome = await destroyInstance({
            apiToken,
            accountId,
            instance: instanceName,
            emptyBucket: async bucket => {
              await emptyBucket(accountId, apiToken, bucket);
            },
            emit: async e => {
              steps.push(e);
              send({ type: 'step', ...e });
              await updateRow(db, id, { steps: JSON.stringify(steps) }).catch(() => undefined);
            },
          });
          await db
            .prepare(
              "UPDATE deploy_instances SET status = 'destroyed', updated_at = ? WHERE account_id = ? AND instance_name = ?"
            )
            .bind(Date.now(), accountId, instanceName)
            .run();
          await updateRow(db, id, {
            status: 'destroyed',
            steps: JSON.stringify(steps),
            error: null,
          });
          send({
            type: 'done',
            retainedBucket: outcome.retainedBucket,
            retainedReason: outcome.retainedReason,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'destroy failed';
          await updateRow(db, id, { error: message, steps: JSON.stringify(steps) }).catch(
            () => undefined
          );
          send({ type: 'error', message });
        }
      });
    }
  );
