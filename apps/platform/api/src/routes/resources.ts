/** Dashboard CRUD: domains, API keys, templates, suppressions, webhooks, settings. */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { EVENT_TYPES, newId, randomHex, sha256Hex, signWebhook, SUPPRESSION_REASONS, type WebhookEvent } from '@postey/shared';
import { sendingDnsChecks, sendingDnsReady } from '../lib/dns';
import type { Bindings, Variables } from '../types';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const domainName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i, 'must be a hostname');

/* ── domains ─────────────────────────────────────────────────────── */

app.get('/domains', async c => {
  const rows = await c.env.DB.prepare(
    `SELECT d.*,
       (SELECT COUNT(*) FROM messages m WHERE m.domain_id = d.id) AS message_count,
       (SELECT COUNT(*) FROM api_keys k WHERE k.domain_id = d.id AND k.revoked_at IS NULL) AS key_count,
       (SELECT COUNT(*) FROM templates t WHERE t.domain_id = d.id) AS template_count
     FROM domains d ORDER BY d.created_at`
  ).all<Record<string, unknown> & { name: string; status: string }>();
  // Live onboarding readiness for non-active domains (capped; DoH is cheap).
  const pending = rows.results.filter(d => d.status !== 'active').slice(0, 10);
  const readiness = await Promise.all(pending.map(d => sendingDnsReady(d.name)));
  const readyByName = new Map(pending.map((d, i) => [d.name, readiness[i]]));
  return c.json({
    data: rows.results.map(d => ({
      ...d,
      dns_ready: d.status === 'active' ? true : (readyByName.get(d.name) ?? null),
    })),
  });
});

app.post('/domains', zValidator('json', z.object({ name: domainName }) ), async c => {
  const name = c.req.valid('json').name.toLowerCase();
  const id = newId('dom');
  try {
    await c.env.DB.prepare(
      "INSERT INTO domains (id, name, status, created_at) VALUES (?, ?, 'pending', ?)"
    )
      .bind(id, name, Date.now())
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return c.json({ error: 'Domain already exists' }, 409);
    }
    throw err;
  }
  return c.json({ data: { id, name, status: 'pending' } });
});

// Live per-record onboarding checks for the domain info drawer.
app.get('/domains/:id/checks', async c => {
  const domain = await c.env.DB.prepare('SELECT name FROM domains WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ name: string }>();
  if (!domain) return c.json({ error: 'Not found' }, 404);
  return c.json({ data: await sendingDnsChecks(domain.name) });
});

app.post('/domains/:id/activate', async c => {
  const domain = await c.env.DB.prepare('SELECT id, name FROM domains WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; name: string }>();
  if (!domain) return c.json({ error: 'Not found' }, 404);
  // Verified activation: refuse until Cloudflare's onboarding records exist,
  // so an active domain always means "sends will actually be accepted".
  if (!(await sendingDnsReady(domain.name))) {
    return c.json(
      {
        error:
          `${domain.name} is not onboarded to Email Sending yet - no cf-bounce DNS records found. ` +
          `Onboard it first (Cloudflare dashboard → Email Service → Email Sending → Onboard Domain, ` +
          `or \`npx wrangler email sending enable ${domain.name}\`), then activate. ` +
          `DNS can take a few minutes to propagate.`,
      },
      409
    );
  }
  await c.env.DB.prepare("UPDATE domains SET status = 'active', onboarded_at = ? WHERE id = ?")
    .bind(Date.now(), domain.id)
    .run();
  return c.json({ data: { ok: true } });
});

app.put(
  '/domains/:id',
  zValidator('json', z.object({ default_from: z.string().max(320).nullable() })),
  async c => {
    const { meta } = await c.env.DB.prepare('UPDATE domains SET default_from = ? WHERE id = ?')
      .bind(c.req.valid('json').default_from, c.req.param('id'))
      .run();
    if (!meta.changes) return c.json({ error: 'Not found' }, 404);
    return c.json({ data: { ok: true } });
  }
);

// Archive: keeps the domain and its history but stops sending immediately -
// the send worker refuses any non-'active' status. Reversible via activate
// (which re-verifies the onboarding DNS before flipping back on).
app.post('/domains/:id/archive', async c => {
  const { meta } = await c.env.DB.prepare(
    "UPDATE domains SET status = 'archived' WHERE id = ? AND status = 'active'"
  )
    .bind(c.req.param('id'))
    .run();
  if (!meta.changes) return c.json({ error: 'Domain not found or not active' }, 409);
  return c.json({ data: { ok: true } });
});

app.delete('/domains/:id', async c => {
  const id = c.req.param('id');
  const used = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE domain_id = ?')
    .bind(id)
    .first<{ n: number }>();
  if ((used?.n ?? 0) > 0) {
    return c.json({ error: 'Domain has send history; archive it instead' }, 409);
  }
  // Detach scoped resources first so the FK references never dangle: scoped
  // keys are revoked and unscoped, scoped templates become shared, scoped
  // suppressions go with the domain.
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE api_keys SET domain_id = NULL, revoked_at = COALESCE(revoked_at, ?) WHERE domain_id = ?'
    ).bind(Date.now(), id),
    c.env.DB.prepare('UPDATE templates SET domain_id = NULL WHERE domain_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM suppressions WHERE domain_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(id),
  ]);
  return c.json({ data: { ok: true } });
});

/* ── api keys ────────────────────────────────────────────────────── */

app.get('/keys', async c => {
  const rows = await c.env.DB.prepare(
    `SELECT k.id, k.name, k.key_prefix, k.domain_id, d.name AS domain_name,
            k.last_used_at, k.created_at, k.revoked_at
     FROM api_keys k LEFT JOIN domains d ON d.id = k.domain_id ORDER BY k.created_at DESC`
  ).all();
  return c.json({ data: rows.results });
});

app.post(
  '/keys',
  zValidator(
    'json',
    z.object({ name: z.string().min(1).max(100), domain_id: z.string().max(64).optional() })
  ),
  async c => {
    const { name, domain_id } = c.req.valid('json');
    if (domain_id) {
      const domain = await c.env.DB.prepare('SELECT id FROM domains WHERE id = ?')
        .bind(domain_id)
        .first();
      if (!domain) return c.json({ error: 'Unknown domain for key scope' }, 422);
    }
    const plaintext = `pk_live_${randomHex(20)}`;
    const id = newId('key');
    await c.env.DB.prepare(
      'INSERT INTO api_keys (id, name, key_hash, key_prefix, domain_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(id, name, await sha256Hex(plaintext), plaintext.slice(0, 12), domain_id ?? null, Date.now())
      .run();
    // The plaintext key travels to the browser exactly once, here.
    return c.json({ data: { id, name, key: plaintext } });
  }
);

app.delete('/keys/:id', async c => {
  const { meta } = await c.env.DB.prepare(
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
  )
    .bind(Date.now(), c.req.param('id'))
    .run();
  if (!meta.changes) return c.json({ error: 'Not found' }, 404);
  return c.json({ data: { ok: true } });
});

/* ── templates ───────────────────────────────────────────────────── */

const templateSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  subject: z.string().min(1).max(998),
  html: z.string().max(500_000).nullable().optional(),
  text: z.string().max(500_000).nullable().optional(),
  variables: z.array(z.string().max(64)).max(50).optional(),
  /** NULL/absent = shared across all domains. */
  domain_id: z.string().max(64).nullable().optional(),
});

app.get('/templates', async c => {
  const rows = await c.env.DB.prepare(
    `SELECT t.*, d.name AS domain_name FROM templates t
     LEFT JOIN domains d ON d.id = t.domain_id ORDER BY t.updated_at DESC`
  ).all();
  return c.json({ data: rows.results });
});

app.post('/templates', zValidator('json', templateSchema), async c => {
  const t = c.req.valid('json');
  const id = newId('tpl');
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      'INSERT INTO templates (id, slug, name, subject, html, text, variables_json, domain_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(id, t.slug, t.name, t.subject, t.html ?? null, t.text ?? null,
        t.variables ? JSON.stringify(t.variables) : null, t.domain_id ?? null, now, now)
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return c.json({ error: 'A template with that slug already exists' }, 409);
    }
    throw err;
  }
  return c.json({ data: { id } });
});

app.put('/templates/:id', zValidator('json', templateSchema.partial()), async c => {
  const t = c.req.valid('json');
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [col, val] of Object.entries({
    slug: t.slug,
    name: t.name,
    subject: t.subject,
    html: t.html,
    text: t.text,
    variables_json: t.variables ? JSON.stringify(t.variables) : undefined,
    domain_id: t.domain_id,
  })) {
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      binds.push(val);
    }
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  sets.push('updated_at = ?', 'version = version + 1');
  binds.push(Date.now(), c.req.param('id'));
  const { meta } = await c.env.DB.prepare(
    `UPDATE templates SET ${sets.join(', ')} WHERE id = ?`
  )
    .bind(...binds)
    .run();
  if (!meta.changes) return c.json({ error: 'Not found' }, 404);
  return c.json({ data: { ok: true } });
});

app.delete('/templates/:id', async c => {
  await c.env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ data: { ok: true } });
});

/* ── suppressions ────────────────────────────────────────────────── */

app.get('/suppressions', async c => {
  const q = c.req.query('q')?.toLowerCase() ?? '';
  const reason = c.req.query('reason') ?? '';
  let sql = `SELECT s.*, d.name AS domain_name FROM suppressions s
     LEFT JOIN domains d ON d.id = s.domain_id
     WHERE s.address LIKE ?`;
  const binds: unknown[] = [`%${q}%`];
  if ((SUPPRESSION_REASONS as readonly string[]).includes(reason)) {
    sql += ' AND s.reason = ?';
    binds.push(reason);
  }
  sql += ' ORDER BY s.created_at DESC LIMIT 200';
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return c.json({ data: rows.results });
});

/** Entry counts per reason, for the filter chips. */
app.get('/suppressions/counts', async c => {
  const rows = await c.env.DB.prepare(
    'SELECT reason, COUNT(*) AS n FROM suppressions GROUP BY reason'
  ).all<{ reason: string; n: number }>();
  return c.json({ data: rows.results });
});

app.post(
  '/suppressions',
  zValidator(
    'json',
    z.object({
      address: z.string().email(),
      reason: z.enum(SUPPRESSION_REASONS).default('manual'),
      domain_id: z.string().max(64).nullable().optional(),
    })
  ),
  async c => {
    const s = c.req.valid('json');
    await c.env.DB.prepare(
      'INSERT INTO suppressions (id, domain_id, address, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
    )
      .bind(newId('sup'), s.domain_id ?? null, s.address.toLowerCase(), s.reason, Date.now())
      .run();
    return c.json({ data: { ok: true } });
  }
);

app.delete('/suppressions/:id', async c => {
  await c.env.DB.prepare('DELETE FROM suppressions WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ data: { ok: true } });
});

/* ── webhooks ────────────────────────────────────────────────────── */

/* The old regex (no dot after "email.") rejected email.reply.received - the
 * exact strings the dispatchers emit are the only valid subscriptions. */
const VALID_WEBHOOK_EVENTS = new Set(['*', ...EVENT_TYPES.map(t => `email.${t}`)]);
const webhookEvents = z
  .array(z.string().refine(e => VALID_WEBHOOK_EVENTS.has(e), 'Unknown event type'))
  .min(1)
  .max(20);

app.get('/webhooks', async c => {
  const rows = await c.env.DB.prepare(
    'SELECT id, url, secret, events_json, enabled, created_at FROM webhooks ORDER BY created_at'
  ).all();
  return c.json({ data: rows.results });
});

app.post(
  '/webhooks',
  zValidator('json', z.object({ url: z.string().url().max(2048), events: webhookEvents })),
  async c => {
    const { url, events } = c.req.valid('json');
    const id = newId('wh');
    const secret = `whsec_${randomHex(24)}`;
    await c.env.DB.prepare(
      'INSERT INTO webhooks (id, url, secret, events_json, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(id, url, secret, JSON.stringify(events), Date.now())
      .run();
    return c.json({ data: { id, secret } });
  }
);

app.put(
  '/webhooks/:id',
  zValidator(
    'json',
    z.object({
      url: z.string().url().max(2048).optional(),
      events: webhookEvents.optional(),
      enabled: z.boolean().optional(),
    })
  ),
  async c => {
    const w = c.req.valid('json');
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (w.url !== undefined) {
      sets.push('url = ?');
      binds.push(w.url);
    }
    if (w.events !== undefined) {
      sets.push('events_json = ?');
      binds.push(JSON.stringify(w.events));
    }
    if (w.enabled !== undefined) {
      sets.push('enabled = ?');
      binds.push(w.enabled ? 1 : 0);
    }
    if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
    binds.push(c.req.param('id'));
    const { meta } = await c.env.DB.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
    if (!meta.changes) return c.json({ error: 'Not found' }, 404);
    return c.json({ data: { ok: true } });
  }
);

app.delete('/webhooks/:id', async c => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(id),
  ]);
  return c.json({ data: { ok: true } });
});

app.get('/webhooks/:id/deliveries', async c => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY last_attempt_at DESC LIMIT 50'
  )
    .bind(c.req.param('id'))
    .all();
  return c.json({ data: rows.results });
});

/** Sample payload for test deliveries - clearly fake ids, real shape, and a
 *  detail line so receiving handlers can tell it apart from live traffic. */
function sampleWebhookEvent(type: string): WebhookEvent {
  const detail = 'Test delivery from the dashboard - not a real event';
  const data =
    type === 'email.reply.received'
      ? {
          reply_id: 'inb_test_0000000000000000',
          message_id: 'msg_test_0000000000000000',
          from: 'customer@example.com',
          to: 'support@yourdomain.com',
          subject: 'Re: Welcome aboard',
          detail,
        }
      : {
          message_id: 'msg_test_0000000000000000',
          recipient: 'customer@example.com',
          from: 'hello@yourdomain.com',
          subject: 'Welcome aboard',
          detail,
        };
  return { type: type as WebhookEvent['type'], created_at: new Date().toISOString(), data };
}

/* One signed delivery to the endpoint, exactly as the live dispatchers send
 * it (Postey-Signature over the raw body + Postey-Event), but a single
 * attempt with the requester watching - no retries. Recorded in the
 * delivery log so the ticks and drawer history show it. */
app.post('/webhooks/:id/test', async c => {
  const hook = await c.env.DB.prepare('SELECT id, url, secret, events_json FROM webhooks WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ id: string; url: string; secret: string; events_json: string }>();
  if (!hook) return c.json({ error: 'Not found' }, 404);

  let events: string[] = [];
  try {
    events = JSON.parse(hook.events_json) as string[];
  } catch {
    /* fall through to the default event */
  }
  const eventType = events.find(e => e !== '*') ?? 'email.delivered';
  const body = JSON.stringify(sampleWebhookEvent(eventType));

  const started = Date.now();
  let responseCode: number | null = null;
  let ok = false;
  let failure: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Postey-Signature': await signWebhook(hook.secret, body),
        'Postey-Event': eventType,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    responseCode = res.status;
    ok = res.ok;
  } catch (err) {
    failure = err instanceof Error ? err.message : 'request failed';
  }
  const duration = Date.now() - started;

  await c.env.DB.prepare(
    'INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, response_code, last_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  )
    .bind(newId('whd'), hook.id, newId('evt'), eventType, ok ? 'delivered' : 'failed', responseCode, Date.now())
    .run()
    .catch(() => undefined);

  return c.json({
    data: {
      ok,
      event: eventType,
      response_code: responseCode,
      duration_ms: duration,
      ...(failure ? { error: failure.slice(0, 200) } : {}),
    },
  });
});

/* ── template test sends ─────────────────────────────────────────── */

/** Sends the (already variable-filled) template content straight through the
 *  Email Service binding. Deliberately outside the message log - it's a
 *  preview in your inbox, not traffic. */
app.post(
  '/test-send',
  zValidator(
    'json',
    z.object({
      to: z.string().email(),
      subject: z.string().min(1).max(998),
      html: z.string().max(500_000).nullable(),
      text: z.string().max(500_000).nullable(),
      domain_id: z.string().optional(),
    })
  ),
  async c => {
    if (!c.env.EMAIL) {
      return c.json(
        { error: 'This instance predates test sends - run an update from postey.app to enable them.' },
        501
      );
    }
    const body = c.req.valid('json');
    if (!body.html && !body.text) {
      return c.json({ error: 'The template has no HTML or text body yet' }, 422);
    }
    const domain = body.domain_id
      ? await c.env.DB.prepare("SELECT name, status, default_from FROM domains WHERE id = ?")
          .bind(body.domain_id)
          .first<{ name: string; status: string; default_from: string | null }>()
      : await c.env.DB.prepare("SELECT name, status, default_from FROM domains WHERE status = 'active' LIMIT 1")
          .first<{ name: string; status: string; default_from: string | null }>();
    if (!domain) return c.json({ error: 'No sending domain found - add one on the Domains page' }, 409);
    if (domain.status !== 'active') {
      return c.json({ error: `${domain.name} is not active - verify & activate it first` }, 409);
    }
    try {
      await c.env.EMAIL.send({
        to: [body.to],
        from: domain.default_from ?? `test@${domain.name}`,
        subject: `[Test] ${body.subject}`,
        ...(body.html ? { html: body.html } : {}),
        ...(body.text ? { text: body.text } : {}),
      });
      return c.json({ data: { ok: true } });
    } catch (raw) {
      const err = raw as Error & { code?: string };
      return c.json(
        { error: `${err.code ?? 'E_UNKNOWN'}: ${err.message ?? 'send failed'}` },
        502
      );
    }
  }
);

export const resourcesRoute = app;
