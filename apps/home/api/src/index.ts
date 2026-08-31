import { Hono } from 'hono';
import type { Bindings, InstanceRow, SendingDomainChoice } from './types';
import { deployRoute, oauthCallback } from './deploy/routes';

/**
 * postey.app home worker: the deploy-wizard BACKEND only. Physically separate
 * from the platform api that ships to customer instances - different worker,
 * different D1 (registry only). Marketing site + wizard UI is the postey-site
 * static worker; this one claims postey.app/api/* via zone routes.
 */
const app = new Hono<{ Bindings: Bindings }>();

app.get('/', c => c.json({ name: 'postey-home-api', status: 'ok' }));
app.get('/api/health', c => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/api/config', c => c.json({ oauthEnabled: Boolean(c.env.CF_OAUTH_CLIENT_ID) }));

// "Sign in with Cloudflare" redirect URI (registered on the OAuth client).
app.get('/deploy/callback', oauthCallback);

const routes = app.route('/api/deploy', deployRoute);

/**
 * Operator-only registry stats (same model as Traks). Hidden: nothing links
 * here, and without the ADMIN_KEY secret the route is indistinguishable from
 * a 404. Present the key as `Authorization: Bearer <key>` or `?key=<key>`
 * (the latter appears in your own history/logs - rotate if shared).
 * Aggregates only by default; `?detail=1` adds the live instances and failed
 * deploys - still no tokens, emails, or full step logs.
 */

/** Rows that represent a running instance: ready, or a failed re-run of an
 *  instance that had shipped before (the previous worker is still live). */
const LIVE = "(status = 'ready' OR (status = 'failed' AND deployed_version IS NOT NULL))";

const domainOf = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as SendingDomainChoice;
    return d.subdomain ? `${d.subdomain}.${d.zoneName}` : d.zoneName;
  } catch {
    return null;
  }
};

app.get('/api/admin/instances', async c => {
  const expected = c.env.ADMIN_KEY;
  const auth = c.req.header('authorization') ?? '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : (c.req.query('key') ?? '');
  if (!expected || !timingSafeEqual(supplied, expected)) {
    return c.json({ error: 'Not found' }, 404);
  }
  const db = c.env.DB;
  const now = Date.now();
  const since = (days: number): number => now - days * 86_400_000;

  const [byStatus, accounts, byVersion, recent7, recent30] = await Promise.all([
    db.prepare('SELECT status, COUNT(*) AS n FROM deploy_instances GROUP BY status').all<{
      status: string;
      n: number;
    }>(),
    db
      .prepare(`SELECT COUNT(DISTINCT account_id) AS n FROM deploy_instances WHERE ${LIVE}`)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT deployed_version AS version, COUNT(*) AS n FROM deploy_instances WHERE ${LIVE} GROUP BY deployed_version`
      )
      .all<{ version: string | null; n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM deploy_instances WHERE ${LIVE} AND created_at >= ?`)
      .bind(since(7))
      .first<{ n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM deploy_instances WHERE ${LIVE} AND created_at >= ?`)
      .bind(since(30))
      .first<{ n: number }>(),
  ]);

  const status = Object.fromEntries(byStatus.results.map(r => [r.status, Number(r.n)]));
  const detail = c.req.query('detail') === '1';

  const instances = detail
    ? (
        await db
          .prepare(
            `SELECT instance_name, api_url, send_url, sending_domain, deployed_version, created_at, updated_at
             FROM deploy_instances WHERE ${LIVE} ORDER BY created_at DESC`
          )
          .all<InstanceRow>()
      ).results.map(r => ({
        instanceName: r.instance_name,
        apiUrl: r.api_url,
        sendUrl: r.send_url,
        domain: domainOf(r.sending_domain),
        version: r.deployed_version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    : undefined;

  const failed = detail
    ? (
        await db
          .prepare(
            `SELECT instance_name, error, steps, updated_at FROM deploy_instances
             WHERE status = 'failed' OR error IS NOT NULL ORDER BY updated_at DESC`
          )
          .all<InstanceRow>()
      ).results.map(r => {
        const steps = r.steps
          ? (JSON.parse(r.steps) as { label: string; status: string; detail?: string }[])
          : [];
        const fail = steps.find(s => s.status === 'fail');
        return {
          instanceName: r.instance_name,
          step: fail?.label ?? null,
          detail: fail?.detail?.slice(0, 300) ?? null,
          error: r.error?.slice(0, 300) ?? null,
          updatedAt: r.updated_at,
        };
      })
    : undefined;

  return c.json({
    generatedAt: now,
    /** Instances currently deployed and healthy as far as the wizard knows. */
    live: status.ready ?? 0,
    /** Distinct Cloudflare accounts behind the live instances. */
    accounts: Number(accounts?.n ?? 0),
    /** Live instances whose install landed within the window. */
    newLast7d: Number(recent7?.n ?? 0),
    newLast30d: Number(recent30?.n ?? 0),
    byStatus: status,
    byVersion: Object.fromEntries(byVersion.results.map(r => [r.version ?? 'unknown', Number(r.n)])),
    ...(instances ? { instances } : {}),
    ...(failed ? { failed } : {}),
  });
});

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && x.length > 0;
}

app.notFound(c => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export type AppType = typeof routes;

/** Nightly sweep of abandoned ('new') wizard sessions older than a day. */
async function sweepAbandonedSessions(env: Bindings): Promise<void> {
  await env.DB.prepare("DELETE FROM deploy_instances WHERE status = 'new' AND created_at < ?")
    .bind(Date.now() - 24 * 3600 * 1000)
    .run();
}

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): void => {
    ctx.waitUntil(sweepAbandonedSessions(env).catch(err => console.error('[sweep] failed:', err)));
  },
};
