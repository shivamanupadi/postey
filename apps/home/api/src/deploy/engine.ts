/**
 * Web-installer provisioning engine (Traks pattern, adapted for email).
 *
 * Pure fetch against the Cloudflare REST API - provisions a complete Postey
 * instance into a USER'S account using tokens they supply, which live only
 * for the duration of the request and are never persisted or logged.
 *
 * Postey-specific legs beyond the Traks engine:
 *  - a Queue (delivery events) with the send worker attached as consumer,
 *  - the send_email binding on the send worker,
 *  - Email Sending domain onboarding: best-effort enable calls, then DNS
 *    polling for the locked cf-bounce records (there is no stable public
 *    onboarding API while the product is in beta - the wizard deep-links the
 *    dashboard and this step detects completion either way).
 */

const API = 'https://api.cloudflare.com/client/v4';

export interface StepEvent {
  stepId: string;
  label: string;
  status: 'start' | 'ok' | 'fail' | 'retry';
  detail?: string;
}

export interface DeployArtifacts {
  apiWorker: () => Promise<Uint8Array>;
  sendWorker: () => Promise<Uint8Array>;
  inboundWorker: () => Promise<Uint8Array>;
  webAssets: {
    path: string;
    hash: string;
    size: number;
    contentType: string | null;
    getContent: () => Promise<Uint8Array>;
  }[];
  migrations: { name: string; getSql: () => Promise<string> }[];
  version?: string;
}

export interface SendingDomain {
  zoneId: string;
  /** Full sending domain, e.g. mail.example.com or the apex. */
  hostname: string;
}

export interface EngineCtx {
  apiToken: string;
  accountId: string;
  instance: string;
  artifacts: DeployArtifacts;
  sendingDomain: SendingDomain;
  deploySessionId?: string;
  randomHex: (bytes: number) => string;
  emit: (e: StepEvent) => void | Promise<void>;
}

interface CfError extends Error {
  status?: number;
  codes?: number[];
}

export function instanceNames(instance: string) {
  return {
    apiWorker: `${instance}-api`,
    sendWorker: `${instance}-send`,
    inboundWorker: `${instance}-inbound`,
    d1: `${instance}-db`,
    bucket: `${instance}-bodies`,
    /** Legacy send queue - no longer provisioned, still torn down on destroy. */
    queue: `${instance}-send-queue`,
    eventsQueue: `${instance}-events-queue`,
  };
}

type Cf = (
  method: string,
  path: string,
  body?: unknown,
  opts?: { jwt?: string; formData?: FormData; tolerate?: number[] }
) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function makeApi(ctx: { apiToken: string }): Cf {
  return async function cf(method, path, body, { jwt, formData, tolerate = [] } = {}) {
    const headers: Record<string, string> = { Authorization: `Bearer ${jwt ?? ctx.apiToken}` };
    let payload: BodyInit | undefined;
    if (formData) {
      payload = formData;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${API}${path}`, { method, headers, body: payload });
    let data: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (res.ok && data?.success !== false) return data?.result ?? data;
    const errors: { code: number; message: string }[] = data?.errors ?? [
      { code: res.status, message: res.statusText },
    ];
    if (errors.some(e => tolerate.includes(e.code))) return { tolerated: errors[0].code };
    const err = new Error(errors.map(e => `[${e.code}] ${e.message}`).join('; ')) as CfError;
    err.status = res.status;
    err.codes = errors.map(e => e.code);
    throw err;
  };
}

class StepFailure extends Error {
  stepId: string;
  constructor(stepId: string, message: string) {
    super(message);
    this.stepId = stepId;
  }
}

/** Cap on a persisted step detail (upstream bodies can be arbitrarily large). */
const MAX_DETAIL = 300;

async function step<T>(
  ctx: { emit: EngineCtx['emit'] },
  stepId: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  await ctx.emit({ stepId, label, status: 'start' });
  try {
    const result = await fn();
    await ctx.emit({ stepId, label, status: 'ok' });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.emit({ stepId, label, status: 'fail', detail: message.slice(0, MAX_DETAIL) });
    throw new StepFailure(stepId, message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function base64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* ── steps ───────────────────────────────────────────────────────── */

async function workersSubdomain(ctx: EngineCtx, cf: Cf): Promise<string> {
  const res = await cf('GET', `/accounts/${ctx.accountId}/workers/subdomain`);
  if (!res?.subdomain) {
    throw new Error(
      'This account has no workers.dev subdomain registered. Open the Cloudflare dashboard → Workers and register one, then retry.'
    );
  }
  return res.subdomain;
}

async function ensureD1(ctx: EngineCtx, cf: Cf, d1Name: string): Promise<string> {
  return step(ctx, 'd1', 'Create D1 database', async () => {
    const list = await cf(
      'GET',
      `/accounts/${ctx.accountId}/d1/database?name=${d1Name}&per_page=100`
    );
    const existing = (Array.isArray(list) ? list : []).find(
      (d: { name: string }) => d.name === d1Name
    );
    if (existing) return existing.uuid as string;
    const created = await cf('POST', `/accounts/${ctx.accountId}/d1/database`, { name: d1Name });
    return created.uuid as string;
  });
}

async function d1Query(ctx: EngineCtx, cf: Cf, d1Id: string, sql: string): Promise<any> {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let attempt = 1; ; attempt++) {
    try {
      return await cf('POST', `/accounts/${ctx.accountId}/d1/database/${d1Id}/query`, { sql });
    } catch (raw) {
      const err = raw as CfError;
      if (attempt >= 4 || ![429, 500, 502, 503].includes(err.status ?? 0)) throw raw;
      await sleep(5_000);
    }
  }
}

async function applyMigrations(ctx: EngineCtx, cf: Cf, d1Id: string): Promise<void> {
  await step(ctx, 'db-migrations', 'Apply database migrations', async () => {
    await d1Query(
      ctx,
      cf,
      d1Id,
      'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp);'
    );
    const appliedRes = await d1Query(ctx, cf, d1Id, 'SELECT name FROM d1_migrations;');
    const applied = new Set<string>(
      (appliedRes?.[0]?.results ?? []).map((r: { name: string }) => r.name)
    );
    for (const m of ctx.artifacts.migrations) {
      if (applied.has(m.name)) continue;
      const sql = await m.getSql();
      // One request per migration: statements plus the bookkeeping row land
      // together, so a failure leaves no half-applied migration behind.
      const statements = sql
        .split('--> statement-breakpoint')
        .map(stmt => stmt.trim())
        .filter(Boolean)
        .map(stmt => (stmt.endsWith(';') ? stmt : `${stmt};`));
      statements.push(
        `INSERT INTO d1_migrations (name) VALUES ('${m.name.replaceAll("'", "''")}');`
      );
      await d1Query(ctx, cf, d1Id, statements.join('\n'));
    }
  });
}

async function seedSendingDomain(ctx: EngineCtx, cf: Cf, d1Id: string): Promise<void> {
  const d = ctx.sendingDomain;
  await d1Query(
    ctx,
    cf,
    d1Id,
    `INSERT INTO domains (id, name, zone_id, status, created_at)
     VALUES ('dom_${ctx.randomHex(12)}', '${d.hostname.replaceAll("'", "''")}', '${d.zoneId}', 'pending', ${Date.now()})
     ON CONFLICT(name) DO NOTHING;`
  );
}

async function ensureBucket(ctx: EngineCtx, cf: Cf, bucket: string): Promise<void> {
  await step(ctx, 'bucket', 'Create R2 bodies bucket', async () => {
    await cf(
      'POST',
      `/accounts/${ctx.accountId}/r2/buckets`,
      { name: bucket },
      { tolerate: [10004] }
    );
  });
}

async function ensureQueue(
  ctx: EngineCtx,
  cf: Cf,
  queueName: string,
  stepId: string,
  label: string
): Promise<string> {
  return step(ctx, stepId, label, async () => {
    try {
      let page = 1;
      for (;;) {
        const list = await cf('GET', `/accounts/${ctx.accountId}/queues?page=${page}&per_page=100`);
        const rows = (Array.isArray(list) ? list : (list?.queues ?? [])) as {
          queue_id: string;
          queue_name: string;
        }[];
        const hit = rows.find(q => q.queue_name === queueName);
        if (hit) return hit.queue_id;
        if (rows.length < 100) break;
        page++;
      }
      const created = await cf('POST', `/accounts/${ctx.accountId}/queues`, {
        queue_name: queueName,
      });
      return created.queue_id as string;
    } catch (raw) {
      const err = raw as CfError;
      if (err.status === 403 || err.status === 402) {
        throw new Error(
          'Cloudflare refused to create a Queue. Postey requires the Workers Paid plan ($5/mo) - Queues and Email Sending are not available on the free plan. Upgrade the account and retry; the deploy resumes here.'
        );
      }
      throw raw;
    }
  });
}

async function attachConsumer(
  ctx: EngineCtx,
  cf: Cf,
  queueId: string,
  scriptName: string
): Promise<void> {
  const base = `/accounts/${ctx.accountId}/queues/${queueId}/consumers`;
  const list = await cf('GET', base).catch(() => null);
  const consumers = (Array.isArray(list) ? list : (list?.consumers ?? [])) as {
    script?: string;
    script_name?: string;
  }[];
  if (consumers.some(cn => (cn.script ?? cn.script_name) === scriptName)) return;
  await cf(
    'POST',
    base,
    {
      script_name: scriptName,
      type: 'worker',
      settings: { batch_size: 10, max_retries: 5, max_wait_time_ms: 2000 },
    },
    { tolerate: [100109, 10023] } // consumer-already-exists flavors
  );
}

const EMAIL_EVENTS = [
  'message.delivered',
  'message.deferred',
  'message.bounced',
  'message.failed',
  'message.rejected',
  'message.complained',
];

/**
 * Subscribe the events queue to Email Sending lifecycle events for the
 * instance's sending domain. Body shape verified against wrangler 4.125's
 * implementation of `queues subscription create --source email.sending`:
 * POST /accounts/{id}/event_subscriptions/subscriptions with
 * source { type, zone_id, domain } and destination { type, queue_id }.
 * Failure degrades gracefully - the consumer works once the subscription is
 * added by hand, and the wizard says exactly how.
 */
async function ensureEventSubscription(
  ctx: EngineCtx,
  cf: Cf,
  eventsQueueId: string
): Promise<void> {
  await step(ctx, 'event-subscription', 'Subscribe to delivery events', async () => {
    const domain = ctx.sendingDomain.hostname;
    const name = `${ctx.instance}-email-events`;
    const base = `/accounts/${ctx.accountId}/event_subscriptions/subscriptions`;

    const existing = await cf('GET', `${base}?per_page=100`).catch(() => null);
    const list = (Array.isArray(existing) ? existing : (existing?.subscriptions ?? [])) as {
      name?: string;
    }[];
    if (list.some(s => s.name === name)) return;

    try {
      await cf('POST', base, {
        name,
        enabled: true,
        source: { type: 'email.sending', zone_id: ctx.sendingDomain.zoneId, domain },
        destination: { type: 'queues.queue', queue_id: eventsQueueId },
        events: EMAIL_EVENTS,
      });
    } catch (err) {
      // Degrade gracefully with instructions. Delivery still works; statuses
      // simply stay at 'sent' until the subscription is added by hand.
      await ctx.emit({
        stepId: 'event-subscription',
        label: 'Subscribe to delivery events',
        status: 'retry',
        detail:
          `Could not create the event subscription automatically (${err instanceof Error ? err.message.slice(0, 80) : 'error'}). One-time manual fix: npx wrangler queues subscription create ${ctx.instance}-events-queue --source email.sending --zone-id ${ctx.sendingDomain.zoneId} --domain ${domain} --events ${EMAIL_EVENTS.join(',')}`.slice(
            0,
            MAX_DETAIL
          ),
      });
    }
  });
}

async function scriptExists(ctx: EngineCtx, cf: Cf, name: string): Promise<boolean> {
  try {
    await cf('GET', `/accounts/${ctx.accountId}/workers/services/${name}`);
    return true;
  } catch {
    return false;
  }
}

async function uploadWorker(
  ctx: EngineCtx,
  cf: Cf,
  name: string,
  moduleBytes: Uint8Array,
  metadata: Record<string, unknown>
): Promise<void> {
  const fd = new FormData();
  // keep_bindings: uploads replace the ENTIRE binding set - without it every
  // update drops the worker's secrets (CLAIM_TOKEN and friends).
  const withKeep = { ...metadata, keep_bindings: ['secret_text', 'secret_key'] };
  fd.append(
    'metadata',
    new Blob([JSON.stringify(withKeep)], { type: 'application/json' }),
    'metadata.json'
  );
  fd.append(
    'worker.js',
    new Blob([moduleBytes as unknown as ArrayBuffer], { type: 'application/javascript+module' }),
    'worker.js'
  );
  await cf('PUT', `/accounts/${ctx.accountId}/workers/scripts/${name}`, undefined, {
    formData: fd,
  });
  await cf('POST', `/accounts/${ctx.accountId}/workers/scripts/${name}/subdomain`, {
    enabled: true,
    previews_enabled: false,
  });
}

async function uploadAssets(ctx: EngineCtx, cf: Cf, apiWorkerName: string): Promise<string> {
  return step(ctx, 'assets', 'Upload dashboard assets', async () => {
    const manifest: Record<string, { hash: string; size: number }> = {};
    const byHash = new Map<string, DeployArtifacts['webAssets'][number]>();
    for (const asset of ctx.artifacts.webAssets) {
      manifest[asset.path] = { hash: asset.hash, size: asset.size };
      byHash.set(asset.hash, asset);
    }
    const session = await cf(
      'POST',
      `/accounts/${ctx.accountId}/workers/scripts/${apiWorkerName}/assets-upload-session`,
      { manifest }
    );
    if (!session?.jwt) throw new Error('assets-upload-session returned no jwt');
    let completionJwt: string = session.buckets?.length ? '' : session.jwt;
    for (const bucket of session.buckets ?? []) {
      const fd = new FormData();
      for (const hash of bucket as string[]) {
        const asset = byHash.get(hash);
        if (!asset) throw new Error(`upload session requested unknown asset hash ${hash}`);
        const content = await asset.getContent();
        fd.append(
          hash,
          new Blob([base64(content)], { type: asset.contentType ?? 'application/null' }),
          hash
        );
      }
      const res = await cf(
        'POST',
        `/accounts/${ctx.accountId}/workers/assets/upload?base64=true`,
        undefined,
        { jwt: session.jwt, formData: fd }
      );
      if (res?.jwt) completionJwt = res.jwt;
    }
    if (!completionJwt) throw new Error('asset upload did not return a completion token');
    return completionJwt;
  });
}

/**
 * Email Sending domain onboarding. There is no stable, documented public API
 * for this while the product is in beta, so:
 *   1. best-effort attempts against the endpoints wrangler-era tooling uses
 *      (each tolerated - a 404/403 just means "not available"), then
 *   2. poll the zone's DNS for the cf-bounce records the dashboard onboarding
 *      creates and locks. Present = onboarded, however it happened.
 * The wizard shows the dashboard deep link while this step is polling.
 */
async function onboardSendingDomain(ctx: EngineCtx, cf: Cf, d1Id: string): Promise<void> {
  const { zoneId, hostname } = ctx.sendingDomain;
  const stepId = 'onboard';
  const label = `Onboard ${hostname} to Email Sending`;
  await step(ctx, stepId, label, async () => {
    const recordsPresent = async (): Promise<boolean> => {
      const spf = await cf(
        'GET',
        `/zones/${zoneId}/dns_records?type=TXT&name=cf-bounce.${hostname}`
      ).catch(() => []);
      const dkim = await cf(
        'GET',
        `/zones/${zoneId}/dns_records?type=TXT&name=cf-bounce._domainkey.${hostname}`
      ).catch(() => []);
      const has = (r: unknown): boolean => Array.isArray(r) && r.length > 0;
      return has(spf) || has(dkim);
    };

    if (!(await recordsPresent())) {
      // Best-effort programmatic enable - shapes may change while in beta.
      await cf('POST', `/zones/${zoneId}/email/sending/enable`, { name: hostname }).catch(
        () => undefined
      );
      await cf('POST', `/accounts/${ctx.accountId}/email/sending/domains`, {
        domain: hostname,
        zone_id: zoneId,
      }).catch(() => undefined);
    }

    const deepLink = 'https://dash.cloudflare.com/?to=/:account/email-service/sending';
    const attempts = 60; // ~10 minutes
    for (let i = 0; i < attempts; i++) {
      if (await recordsPresent()) {
        await d1Query(
          ctx,
          cf,
          d1Id,
          `UPDATE domains SET status = 'active', onboarded_at = ${Date.now()} WHERE name = '${hostname.replaceAll("'", "''")}';`
        );
        return;
      }
      await ctx.emit({
        stepId,
        label,
        status: 'retry',
        detail:
          `Waiting for Email Sending DNS records on ${hostname}. If onboarding has not started, open ${deepLink} → Onboard Domain (two clicks) - detection is automatic. Attempt ${i + 1}/${attempts}`.slice(
            0,
            MAX_DETAIL
          ),
      });
      await sleep(10_000);
    }
    throw new Error(
      `Email Sending records for ${hostname} did not appear. Onboard the domain in the Cloudflare dashboard (Email Service → Email Sending → Onboard Domain) and retry - the deploy resumes here.`
    );
  });
}

async function ensureSecrets(
  ctx: EngineCtx,
  cf: Cf,
  N: ReturnType<typeof instanceNames>
): Promise<void> {
  // Postey's platform auth is DB-session based; the only managed secret is
  // CLAIM_TOKEN, minted in the claim step. This hook stays for future secrets.
  void ctx;
  void cf;
  void N;
}

/* ── public API ──────────────────────────────────────────────────── */

export interface ProvisionResult {
  apiUrl: string;
  sendUrl: string;
  /** One-time code the first sign-up must present. Only present while the
   *  instance is unclaimed; travels to the user's browser once. */
  claimCode?: string;
}

export async function provisionInstance(ctx: EngineCtx): Promise<ProvisionResult> {
  const cf = makeApi(ctx);
  const N = instanceNames(ctx.instance);

  const subdomain = await step(ctx, 'preflight', 'Check account readiness', () =>
    workersSubdomain(ctx, cf)
  );
  const apiUrl = `https://${N.apiWorker}.${subdomain}.workers.dev`;
  const sendUrl = `https://${N.sendWorker}.${subdomain}.workers.dev`;

  const d1Id = await ensureD1(ctx, cf, N.d1);
  await applyMigrations(ctx, cf, d1Id);
  await seedSendingDomain(ctx, cf, d1Id);
  await ensureBucket(ctx, cf, N.bucket);
  const eventsQueueId = await ensureQueue(
    ctx,
    cf,
    N.eventsQueue,
    'events-queue',
    'Create delivery-events queue'
  );

  await step(ctx, 'send-worker', 'Deploy send worker', async () => {
    await uploadWorker(ctx, cf, N.sendWorker, await ctx.artifacts.sendWorker(), {
      main_module: 'worker.js',
      compatibility_date: '2026-08-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        { type: 'd1', name: 'DB', id: d1Id },
        { type: 'r2_bucket', name: 'BODIES', bucket_name: N.bucket },
        { type: 'send_email', name: 'EMAIL' },
        { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
      ],
    });
    await attachConsumer(ctx, cf, eventsQueueId, N.sendWorker);
  });

  await ensureEventSubscription(ctx, cf, eventsQueueId);

  await step(ctx, 'inbound-worker', 'Deploy inbound worker', async () => {
    await uploadWorker(ctx, cf, N.inboundWorker, await ctx.artifacts.inboundWorker(), {
      main_module: 'worker.js',
      compatibility_date: '2026-08-01',
      bindings: [
        { type: 'd1', name: 'DB', id: d1Id },
        { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
      ],
    });
  });

  await onboardSendingDomain(ctx, cf, d1Id);

  const assetsJwt = await uploadAssets(ctx, cf, N.apiWorker);

  await step(ctx, 'api-worker', 'Deploy dashboard worker', async () => {
    await uploadWorker(ctx, cf, N.apiWorker, await ctx.artifacts.apiWorker(), {
      main_module: 'worker.js',
      compatibility_date: '2026-08-01',
      compatibility_flags: ['nodejs_compat'],
      bindings: [
        { type: 'd1', name: 'DB', id: d1Id },
        { type: 'r2_bucket', name: 'BODIES', bucket_name: N.bucket },
        { type: 'assets', name: 'ASSETS' },
        { type: 'plain_text', name: 'ENVIRONMENT', text: 'production' },
        { type: 'plain_text', name: 'SEND_URL', text: sendUrl },
        { type: 'plain_text', name: 'SENDING_DOMAIN', text: ctx.sendingDomain.hostname },
        ...(ctx.artifacts.version
          ? [{ type: 'plain_text', name: 'POSTEY_VERSION', text: ctx.artifacts.version }]
          : []),
        ...(ctx.deploySessionId
          ? [{ type: 'plain_text', name: 'DEPLOY_INSTANCE_ID', text: ctx.deploySessionId }]
          : []),
      ],
      assets: {
        jwt: assetsJwt,
        config: {
          not_found_handling: 'single-page-application',
          run_worker_first: ['/api/*'],
        },
      },
    });
  });

  await ensureSecrets(ctx, cf, N);

  await step(ctx, 'smoke', 'Verify the deployment', async () => {
    const probe = async (url: string, path: string, expect: string): Promise<void> => {
      for (let i = 0; i < 9; i++) {
        let why = '';
        try {
          const res = await fetch(url + path);
          const body = await res.text();
          if (res.ok && body.includes(expect)) return;
          why = `HTTP ${res.status}`;
        } catch (err) {
          why = err instanceof Error ? err.message : 'unreachable';
        }
        await ctx.emit({
          stepId: 'smoke',
          label: 'Verify the deployment',
          status: 'retry',
          detail: `Waiting for ${url}${path} (${why}) - attempt ${i + 1}/9`.slice(0, MAX_DETAIL),
        });
        await sleep(10_000);
      }
      throw new Error(`${url}${path} did not become healthy`);
    };
    await probe(apiUrl, '/api/health', '"ok"');
    await probe(sendUrl, '/health', '"ok"');
  });

  // Predictable hostnames must not be claimable by whoever finds them first.
  let claimCode: string | undefined;
  await step(ctx, 'claim', 'Secure the first sign-up', async () => {
    let unclaimed = false;
    try {
      const res = await fetch(apiUrl + '/api/claim-status');
      const data = (await res.json()) as { claimed?: boolean };
      unclaimed = res.ok && data?.claimed === false;
    } catch {
      /* treat as claimed; a re-run re-mints */
    }
    if (!unclaimed) return;
    const code = ctx.randomHex(12);
    await cf('PUT', `/accounts/${ctx.accountId}/workers/scripts/${N.apiWorker}/secrets`, {
      name: 'CLAIM_TOKEN',
      text: code,
      type: 'secret_text',
    });
    claimCode = code;
  });

  return { apiUrl, sendUrl, claimCode };
}

/* ── account helpers (tokens never stored) ───────────────────────── */

export async function userEmail(apiToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${apiToken}` } });
    const data: any = await res.json(); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!res.ok || data?.success === false) return undefined;
    const email = data?.result?.email;
    return typeof email === 'string' && email.includes('@') ? email : undefined;
  } catch {
    return undefined;
  }
}

export async function listAccounts(apiToken: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${API}/accounts?per_page=50`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const data: any = await res.json().catch(() => null); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!res.ok || data?.success === false) {
    const msg =
      data?.errors?.map((e: { message: string }) => e.message).join('; ') ?? res.statusText;
    throw new Error(msg);
  }
  return (data.result ?? []).map((a: { id: string; name: string }) => ({ id: a.id, name: a.name }));
}

export async function listZones(
  apiToken: string,
  accountId: string
): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${API}/zones?account.id=${accountId}&status=active&per_page=50`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  const data: any = await res.json().catch(() => null); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!res.ok || data?.success === false) {
    const msg =
      data?.errors?.map((e: { message: string }) => e.message).join('; ') ?? res.statusText;
    throw new Error(msg);
  }
  return (data.result ?? []).map((z: { id: string; name: string }) => ({ id: z.id, name: z.name }));
}

/* ── destroy ─────────────────────────────────────────────────────── */

const sha256Hex = async (s: string | Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        typeof s === 'string' ? new TextEncoder().encode(s) : (s as BufferSource)
      )
    ),
  ]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

const hmacSha256 = async (key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> => {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
};

async function s3KeyId(accountId: string, token: string): Promise<string> {
  for (const url of [`${API}/accounts/${accountId}/tokens/verify`, `${API}/user/tokens/verify`]) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json() as Promise<any>) // eslint-disable-line @typescript-eslint/no-explicit-any
      .catch(() => null);
    if (res?.success && res.result?.status === 'active') return res.result.id as string;
  }
  throw new Error('not a valid, active Cloudflare API token');
}

/** Empty an R2 bucket via the S3 API before deletion (R2 refuses to delete
 *  non-empty buckets, and the management API has no purge). */
export async function emptyBucket(
  accountId: string,
  token: string,
  bucket: string
): Promise<number> {
  const keyId = await s3KeyId(accountId, token);
  const secret = await sha256Hex(token);
  const host = `${accountId}.r2.cloudflarestorage.com`;

  const signedFetch = async (
    method: string,
    path: string,
    query: string,
    body: string
  ): Promise<Response> => {
    const amzDate = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const datestamp = amzDate.slice(0, 8);
    const payloadHash = await sha256Hex(body);
    const canonicalPath = path.split('/').map(encodeURIComponent).join('/');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      method,
      canonicalPath,
      query,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${datestamp}/auto/s3/aws4_request`;
    const sts = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    let key = await hmacSha256(new TextEncoder().encode(`AWS4${secret}`), datestamp);
    key = await hmacSha256(key, 'auto');
    key = await hmacSha256(key, 's3');
    key = await hmacSha256(key, 'aws4_request');
    const signature = [...new Uint8Array(await hmacSha256(key, sts))]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return fetch(`https://${host}${canonicalPath}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: body || undefined,
    });
  };

  const unescapeXml = (s: string): string =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  const escapeXml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let total = 0;
  for (let round = 0; round < 500; round++) {
    const listRes = await signedFetch('GET', `/${bucket}/`, 'list-type=2', '');
    if (listRes.status === 404) return total;
    if (!listRes.ok) throw new Error(`bucket list failed (${listRes.status})`);
    const keys = [...(await listRes.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(m =>
      unescapeXml(m[1])
    );
    if (keys.length === 0) return total;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete>${keys
      .map(k => `<Object><Key>${escapeXml(k)}</Key></Object>`)
      .join('')}<Quiet>true</Quiet></Delete>`;
    const delRes = await signedFetch('POST', `/${bucket}/`, 'delete=', xml);
    if (!delRes.ok) throw new Error(`bucket purge failed (${delRes.status})`);
    total += keys.length;
  }
  throw new Error('bucket purge did not converge');
}

export interface DestroyCtx {
  apiToken: string;
  accountId: string;
  instance: string;
  emit: (e: StepEvent) => void | Promise<void>;
  emptyBucket?: (bucket: string) => Promise<void>;
}

export interface DestroyResult {
  retainedBucket: string | null;
  retainedReason: string | null;
}

/** Tear down everything provisionInstance created. Idempotent. */
export async function destroyInstance(ctx: DestroyCtx): Promise<DestroyResult> {
  const cf = makeApi(ctx);
  const N = instanceNames(ctx.instance);
  const gone = [10007, 10000, 7003, 1000, 11000, 100123];
  let retainedBucket: string | null = null;
  let retainedReason: string | null = null;

  await step(ctx, 'workers', 'Delete workers', async () => {
    for (const name of [N.apiWorker, N.sendWorker, N.inboundWorker]) {
      await cf(
        'DELETE',
        `/accounts/${ctx.accountId}/workers/scripts/${name}?force=true`,
        undefined,
        { tolerate: gone }
      ).catch(() => {});
    }
  });

  await step(ctx, 'queue-teardown', 'Delete queues', async () => {
    const list = await cf('GET', `/accounts/${ctx.accountId}/queues?per_page=100`).catch(() => []);
    const rows = (Array.isArray(list) ? list : (list?.queues ?? [])) as {
      queue_id: string;
      queue_name: string;
    }[];
    for (const name of [N.queue, N.eventsQueue]) {
      const hit = rows.find(q => q.queue_name === name);
      if (hit) {
        await cf('DELETE', `/accounts/${ctx.accountId}/queues/${hit.queue_id}`, undefined, {
          tolerate: gone,
        }).catch(() => {});
      }
    }
  });

  await step(ctx, 'bucket-teardown', 'Empty and delete bodies bucket', async () => {
    if (ctx.emptyBucket) {
      try {
        await ctx.emptyBucket(N.bucket);
      } catch (err) {
        retainedBucket = N.bucket;
        retainedReason = `The bucket could not be emptied: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }
    await cf('DELETE', `/accounts/${ctx.accountId}/r2/buckets/${N.bucket}`, undefined, {
      tolerate: gone,
    }).catch(() => {});
  });

  await step(ctx, 'storage-teardown', 'Delete database', async () => {
    const list = await cf(
      'GET',
      `/accounts/${ctx.accountId}/d1/database?name=${N.d1}&per_page=100`
    );
    const db = ((Array.isArray(list) ? list : []) as { uuid: string; name: string }[]).find(
      d => d.name === N.d1
    );
    if (db) {
      await cf('DELETE', `/accounts/${ctx.accountId}/d1/database/${db.uuid}`, undefined, {
        tolerate: gone,
      });
    }
  });

  return { retainedBucket, retainedReason };
}
