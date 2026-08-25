import { Hono } from 'hono';
import type { Bindings } from './types';
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
