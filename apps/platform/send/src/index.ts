/**
 * Postey send worker - the public send API (Resend-compatible surface) and
 * the queue consumer that delivers through Cloudflare Email Service.
 *
 * Requests authenticate with an API key (`Authorization: Bearer pk_...`);
 * keys are stored hashed. Accepted sends are recorded in D1 (metadata) and R2
 * (bodies), then enqueued - delivery, retries, and quota pacing live in the
 * consumer (deliver.ts), never in the request path.
 */
import { Hono, type Context } from 'hono';
import {
  base64ToBytes,
  newId,
  parseAddress,
  renderTemplate,
  sendEmailSchema,
  sha256Hex,
  toList,
  type SendEmailInput,
  type StoredAttachment,
} from '@postey/shared';
import type { Bindings, QueueJob } from './types';
import { deliverBatch } from './deliver';
import { mcpHandler } from './mcp';

type ApiKeyRow = {
  id: string;
  domain_id: string | null;
  revoked_at: number | null;
};

type Variables = { apiKey: ApiKeyRow };
type AppCtx = Context<{ Bindings: Bindings; Variables: Variables }>;

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const MAX_SCHEDULE_MS = 12 * 3600 * 1000; // Queues delaySeconds ceiling

app.get('/', c => c.json({ name: 'postey-send', status: 'ok' }));
app.get('/health', c => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

/* ── API-key auth ────────────────────────────────────────────────── */

app.use('/api/*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!key.startsWith('pk_')) {
    return c.json({ error: 'Missing API key. Pass Authorization: Bearer pk_...' }, 401);
  }
  const hash = await sha256Hex(key);
  const row = await c.env.DB.prepare(
    'SELECT id, domain_id, revoked_at FROM api_keys WHERE key_hash = ?'
  )
    .bind(hash)
    .first<ApiKeyRow>();
  if (!row || row.revoked_at) return c.json({ error: 'Invalid API key' }, 401);
  c.set('apiKey', row);
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .bind(Date.now(), row.id)
      .run()
      .then(() => undefined)
      .catch(() => undefined)
  );
  await next();
});

/* ── send ────────────────────────────────────────────────────────── */

async function handleSend(c: AppCtx): Promise<Response> {
  const key = c.get('apiKey');
  const parsed = sendEmailSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json(
      { error: `Invalid payload: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'body must be JSON'}` },
      422
    );
  }
  const input: SendEmailInput = parsed.data;

  const from = parseAddress(input.from);
  if (!from) return c.json({ error: 'Invalid from address' }, 422);
  const fromDomain = from.email.split('@')[1];

  const domain = await c.env.DB.prepare('SELECT id, name, status FROM domains WHERE name = ?')
    .bind(fromDomain)
    .first<{ id: string; name: string; status: string }>();
  if (!domain) {
    return c.json({ error: `Domain ${fromDomain} is not configured on this instance` }, 403);
  }
  if (domain.status !== 'active') {
    return c.json({ error: `Domain ${fromDomain} is not active yet (status: ${domain.status})` }, 403);
  }
  if (key.domain_id && key.domain_id !== domain.id) {
    return c.json({ error: 'This API key cannot send from that domain' }, 403);
  }

  /* Template merge - a template is usable if shared (no domain) or owned by
   * the message's sending domain. */
  let { subject, html, text } = input;
  if (input.template_id) {
    const tpl = await c.env.DB.prepare(
      'SELECT subject, html, text FROM templates WHERE (id = ? OR slug = ?) AND (domain_id IS NULL OR domain_id = ?)'
    )
      .bind(input.template_id, input.template_id, domain.id)
      .first<{ subject: string; html: string | null; text: string | null }>();
    if (!tpl) return c.json({ error: `Template ${input.template_id} not found` }, 422);
    const vars = input.variables ?? {};
    subject = subject ?? renderTemplate(tpl.subject, vars);
    html = html ?? (tpl.html ? renderTemplate(tpl.html, vars) : undefined);
    text = text ?? (tpl.text ? renderTemplate(tpl.text, vars) : undefined);
  }
  if (!subject) return c.json({ error: 'subject is required' }, 422);
  if (!html && !text) return c.json({ error: 'One of html or text is required' }, 422);

  /* Recipients: dedupe across to/cc/bcc, cap 50 (Email Service limit). */
  const to = toList(input.to);
  const cc = toList(input.cc);
  const bcc = toList(input.bcc);
  const kinds = new Map<string, 'to' | 'cc' | 'bcc'>();
  for (const [kind, list] of [
    ['to', to],
    ['cc', cc],
    ['bcc', bcc],
  ] as const) {
    for (const addr of list) if (!kinds.has(addr)) kinds.set(addr, kind);
  }
  if (kinds.size === 0) return c.json({ error: 'At least one recipient is required' }, 422);
  if (kinds.size > 50) return c.json({ error: 'At most 50 recipients per email' }, 422);

  /* Scheduling (bounded by the queue's max delay). */
  let delaySeconds = 0;
  let scheduledAt: number | null = null;
  if (input.scheduled_at) {
    scheduledAt = Date.parse(input.scheduled_at);
    const delta = scheduledAt - Date.now();
    if (delta > MAX_SCHEDULE_MS) {
      return c.json({ error: 'scheduled_at can be at most 12 hours in the future' }, 422);
    }
    delaySeconds = Math.max(0, Math.floor(delta / 1000));
  }

  /* Idempotency: header wins over body. */
  const idem = c.req.header('idempotency-key') ?? input.idempotency_key ?? null;
  if (idem) {
    const existing = await c.env.DB.prepare(
      'SELECT id FROM messages WHERE api_key_id = ? AND idempotency_key = ?'
    )
      .bind(key.id, idem)
      .first<{ id: string }>();
    if (existing) return c.json({ id: existing.id });
  }

  /* Suppression check - suppressed recipients never leave the API boundary. */
  const addresses = [...kinds.keys()];
  const placeholders = addresses.map(() => '?').join(',');
  const suppressed = new Set(
    (
      await c.env.DB.prepare(
        `SELECT address FROM suppressions WHERE address IN (${placeholders}) AND (domain_id IS NULL OR domain_id = ?)`
      )
        .bind(...addresses, domain.id)
        .all<{ address: string }>()
    ).results.map(r => r.address)
  );
  const live = addresses.filter(a => !suppressed.has(a));

  const id = newId('msg');
  const now = Date.now();
  const status = live.length === 0 ? 'suppressed' : scheduledAt ? 'scheduled' : 'queued';
  const bodyKey = `bodies/${id}.json`;

  /* Attachments: decode base64, store binary under the message's R2 prefix,
   * record a manifest in the body JSON. Total decoded size ≤ 4 MiB. */
  const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
  const attachments: StoredAttachment[] = [];
  if (input.attachments?.length) {
    let total = 0;
    for (let i = 0; i < input.attachments.length; i++) {
      const a = input.attachments[i];
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(a.content);
      } catch {
        return c.json({ error: `attachments[${i}].content is not valid base64` }, 422);
      }
      total += bytes.length;
      if (total > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: 'Attachments exceed the 4 MiB total limit' }, 422);
      }
      const key = `bodies/${id}/att/${i}`;
      await c.env.BODIES.put(key, bytes as unknown as ArrayBuffer);
      attachments.push({
        key,
        filename: a.filename,
        type: a.content_type ?? 'application/octet-stream',
        disposition: a.disposition ?? 'attachment',
        content_id: a.content_id ?? null,
        size: bytes.length,
      });
    }
  }

  await c.env.BODIES.put(
    bodyKey,
    JSON.stringify({
      html: html ?? null,
      text: text ?? null,
      ...(attachments.length ? { attachments } : {}),
    })
  );

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO messages (id, domain_id, api_key_id, from_email, from_name, to_json, cc_json, bcc_json,
         reply_to, subject, body_r2_key, headers_json, template_id, tags_json, idempotency_key, status,
         scheduled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      domain.id,
      key.id,
      from.email,
      from.name ?? null,
      JSON.stringify(to),
      cc.length ? JSON.stringify(cc) : null,
      bcc.length ? JSON.stringify(bcc) : null,
      toList(input.reply_to)[0] ?? null,
      subject,
      bodyKey,
      input.headers ? JSON.stringify(input.headers) : null,
      input.template_id ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      idem,
      status,
      scheduledAt,
      now
    ),
    ...addresses.map(addr =>
      c.env.DB.prepare(
        'INSERT INTO message_recipients (message_id, address, kind, status, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, addr, kinds.get(addr)!, suppressed.has(addr) ? 'suppressed' : 'queued', now)
    ),
    c.env.DB.prepare(
      'INSERT INTO message_events (id, message_id, event, meta_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      newId('evt'),
      id,
      status === 'suppressed' ? 'suppressed' : 'queued',
      suppressed.size ? JSON.stringify({ suppressed: [...suppressed] }) : null,
      now
    ),
  ];
  try {
    await c.env.DB.batch(statements);
  } catch (err) {
    // Idempotency race: two identical requests inserted concurrently.
    if (idem && err instanceof Error && /UNIQUE/i.test(err.message)) {
      const existing = await c.env.DB.prepare(
        'SELECT id FROM messages WHERE api_key_id = ? AND idempotency_key = ?'
      )
        .bind(key.id, idem)
        .first<{ id: string }>();
      if (existing) return c.json({ id: existing.id });
    }
    throw err;
  }

  if (live.length > 0) {
    await c.env.SEND_QUEUE.send({ messageId: id }, delaySeconds ? { delaySeconds } : undefined);
  }

  return c.json({ id }, 200);
}

app.post('/api/emails', handleSend);
app.post('/emails', handleSend); // Resend SDKs post to /emails

/* ── status ──────────────────────────────────────────────────────── */

async function getEmail(c: AppCtx): Promise<Response> {
  const key = c.get('apiKey');
  const row = await c.env.DB.prepare(
    `SELECT id, domain_id, from_email, from_name, to_json, cc_json, bcc_json, subject, status,
            provider_message_id, error_code, error_message, created_at, sent_at, completed_at
     FROM messages WHERE id = ?`
  )
    .bind(c.req.param('id'))
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (key.domain_id && row.domain_id !== key.domain_id) return c.json({ error: 'Not found' }, 404);
  const recipients = await c.env.DB.prepare(
    'SELECT address, kind, status, error FROM message_recipients WHERE message_id = ?'
  )
    .bind(row.id)
    .all();
  return c.json({
    id: row.id,
    from: row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email,
    to: JSON.parse(String(row.to_json)),
    subject: row.subject,
    status: row.status,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    created_at: row.created_at,
    sent_at: row.sent_at,
    completed_at: row.completed_at,
    recipients: recipients.results,
  });
}

async function listEmails(c: AppCtx): Promise<Response> {
  const key = c.get('apiKey');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 50);
  const status = c.req.query('status');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (key.domain_id) {
    where.push('domain_id = ?');
    binds.push(key.domain_id);
  }
  if (status) {
    where.push('status = ?');
    binds.push(status);
  }
  binds.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT id, from_email, to_json, subject, status, error_code, created_at, completed_at
     FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(...binds)
    .all();
  return c.json({ data: rows.results });
}

app.get('/api/emails', listEmails);
app.get('/emails', listEmails);
app.get('/api/emails/:id', getEmail);
app.get('/emails/:id', getEmail);

app.get('/api/templates', async c => {
  const key = c.get('apiKey');
  // A domain-scoped key sees shared templates plus its own domain's.
  const rows = key.domain_id
    ? await c.env.DB.prepare(
        'SELECT id, slug, name, subject, variables_json, domain_id FROM templates WHERE domain_id IS NULL OR domain_id = ? ORDER BY updated_at DESC'
      )
        .bind(key.domain_id)
        .all()
    : await c.env.DB.prepare(
        'SELECT id, slug, name, subject, variables_json, domain_id FROM templates ORDER BY updated_at DESC'
      ).all();
  return c.json({ data: rows.results });
});

app.post('/api/templates', async c => {
  const key = c.get('apiKey');
  const body = (await c.req.json().catch(() => null)) as {
    slug?: string;
    name?: string;
    subject?: string;
    html?: string;
    text?: string;
    variables?: string[];
  } | null;
  if (!body?.slug || !/^[a-z0-9-]{1,64}$/.test(body.slug)) {
    return c.json({ error: 'slug is required (lowercase letters, digits, dashes)' }, 422);
  }
  if (!body.name || !body.subject) return c.json({ error: 'name and subject are required' }, 422);
  if (!body.html && !body.text) return c.json({ error: 'One of html or text is required' }, 422);
  if ((body.html?.length ?? 0) > 500_000 || (body.text?.length ?? 0) > 500_000) {
    return c.json({ error: 'Template body too large' }, 422);
  }
  // A scoped key creates templates owned by its domain; an unscoped key
  // creates shared ones. Slugs are global - replacing requires ownership.
  const scope = key.domain_id ?? null;
  const existing = await c.env.DB.prepare('SELECT domain_id FROM templates WHERE slug = ?')
    .bind(body.slug)
    .first<{ domain_id: string | null }>();
  if (existing && existing.domain_id !== scope) {
    return c.json({ error: `Slug "${body.slug}" is taken by a different domain scope` }, 409);
  }
  const now = Date.now();
  const id = newId('tpl');
  await c.env.DB.prepare(
    `INSERT INTO templates (id, slug, name, subject, html, text, variables_json, domain_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET name = excluded.name, subject = excluded.subject,
       html = excluded.html, text = excluded.text, variables_json = excluded.variables_json,
       version = version + 1, updated_at = excluded.updated_at`
  )
    .bind(
      id,
      body.slug,
      body.name,
      body.subject,
      body.html ?? null,
      body.text ?? null,
      body.variables ? JSON.stringify(body.variables.slice(0, 50)) : null,
      scope,
      now,
      now
    )
    .run();
  return c.json({ data: { slug: body.slug } });
});

app.post('/api/suppressions', async c => {
  const key = c.get('apiKey');
  const body = (await c.req.json().catch(() => null)) as { address?: string } | null;
  const address = body?.address?.toLowerCase().trim();
  if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return c.json({ error: 'A valid address is required' }, 422);
  }
  await c.env.DB.prepare(
    'INSERT INTO suppressions (id, domain_id, address, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
  )
    .bind(newId('sup'), key.domain_id ?? null, address, 'manual', Date.now())
    .run();
  return c.json({ data: { ok: true, address } });
});

app.get('/api/suppressions', async c => {
  const key = c.get('apiKey');
  const q = c.req.query('q')?.toLowerCase() ?? '';
  // A domain-scoped key sees instance-wide entries plus its own domain's.
  const rows = key.domain_id
    ? await c.env.DB.prepare(
        'SELECT address, reason, created_at FROM suppressions WHERE address LIKE ? AND (domain_id IS NULL OR domain_id = ?) ORDER BY created_at DESC LIMIT 100'
      )
        .bind(`%${q}%`, key.domain_id)
        .all()
    : await c.env.DB.prepare(
        'SELECT address, reason, created_at FROM suppressions WHERE address LIKE ? ORDER BY created_at DESC LIMIT 100'
      )
        .bind(`%${q}%`)
        .all();
  return c.json({ data: rows.results });
});

/* MCP endpoint (Streamable HTTP, stateless): behind the same key auth,
 * dispatching in-process so tools reuse the real routes. */
const mcp = mcpHandler(
  (path, init, c) => Promise.resolve(app.request(path, init, c.env, c.executionCtx)),
  () => 'postey'
);
app.post('/api/mcp', c => mcp(c));
app.post('/mcp', c => mcp(c));
app.on(['GET', 'DELETE'], ['/api/mcp', '/mcp'], c =>
  c.json({ error: 'Method not allowed' }, 405)
);

app.notFound(c => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error('send worker error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<QueueJob>, env: Bindings, ctx: ExecutionContext) =>
    deliverBatch(batch, env, ctx),
};
