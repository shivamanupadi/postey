/** Inbox product API: addresses, stored inbound mail, and replies.
 *  Replies deliver inline through the EMAIL binding and are recorded in the
 *  outbound messages log like any send. */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { newId, randomHex } from '@postey/shared';
import { routingDnsChecks } from '../lib/dns';
import type { Bindings, Variables } from '../types';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/** Attachment manifest entry inside an inbound body JSON (inbox/<id>.json);
 *  blobs live at inbox/<id>/att/<n>, written by the inbound worker. */
interface InboxAttachment {
  key: string;
  filename: string;
  type: string;
  size: number;
  disposition: string;
  content_id: string | null;
}

/* ── addresses ───────────────────────────────────────────────────── */

app.get('/inbox/addresses', async c => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.local_part, a.domain_id, d.name AS domain_name, a.created_at,
            (SELECT COUNT(*) FROM inbox_messages m WHERE m.address_id = a.id) AS message_count,
            (SELECT COUNT(*) FROM inbox_messages m WHERE m.address_id = a.id AND m.read_at IS NULL) AS unread_count
     FROM inbox_addresses a JOIN domains d ON d.id = a.domain_id
     ORDER BY d.name, a.local_part`
  ).all();
  return c.json({ data: rows.results });
});

app.post(
  '/inbox/addresses',
  zValidator(
    'json',
    z.object({
      domain_id: z.string().min(1),
      local_part: z
        .string()
        .regex(/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/i, 'Invalid local part'),
    })
  ),
  async c => {
    const { domain_id, local_part } = c.req.valid('json');
    const domain = await c.env.DB.prepare('SELECT id, name, status FROM domains WHERE id = ?')
      .bind(domain_id)
      .first<{ id: string; name: string; status: string }>();
    if (!domain) return c.json({ error: 'Domain not found' }, 404);
    if (domain.status !== 'active') {
      return c.json({ error: `${domain.name} is not active - verify & activate it first` }, 409);
    }
    if (local_part.toLowerCase().startsWith('unsubscribe')) {
      return c.json({ error: 'unsubscribe@ is reserved for the suppression handler' }, 409);
    }
    if (local_part.toLowerCase().startsWith('postey-probe')) {
      return c.json({ error: 'postey-probe@ is reserved for receiving verification' }, 409);
    }
    const id = newId('adr');
    try {
      await c.env.DB.prepare(
        'INSERT INTO inbox_addresses (id, domain_id, local_part, created_at) VALUES (?, ?, ?, ?)'
      )
        .bind(id, domain.id, local_part.toLowerCase(), Date.now())
        .run();
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        return c.json({ error: `${local_part}@${domain.name} already exists` }, 409);
      }
      throw err;
    }
    return c.json({ data: { id, address: `${local_part.toLowerCase()}@${domain.name}` } });
  }
);

app.delete('/inbox/addresses/:id', async c => {
  const id = c.req.param('id');
  // Stored bodies AND their attachment blobs go with the address - no
  // orphaned R2 objects. The manifest in each body names its blobs.
  const keys = await c.env.DB.prepare(
    'SELECT body_r2_key FROM inbox_messages WHERE address_id = ? AND body_r2_key IS NOT NULL'
  )
    .bind(id)
    .all<{ body_r2_key: string }>();
  await Promise.all(
    keys.results.map(async k => {
      try {
        const obj = await c.env.BODIES.get(k.body_r2_key);
        const manifest = obj
          ? ((await obj.json()) as { attachments?: InboxAttachment[] }).attachments
          : undefined;
        await Promise.all((manifest ?? []).map(a => c.env.BODIES.delete(a.key).catch(() => undefined)));
        await c.env.BODIES.delete(k.body_r2_key);
      } catch {
        /* a missing body must not block address removal */
      }
    })
  );
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM inbox_messages WHERE address_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM inbox_addresses WHERE id = ?').bind(id),
  ]);
  return c.json({ data: { ok: true } });
});

/* ── receiving verification ──────────────────────────────────────────
 * "Is this domain actually routing mail to the inbound worker?" answered
 * with the same credential-free philosophy as sending onboarding:
 *  - DNS (DoH): Email Routing onboarding puts route*.mx.cloudflare.net MX
 *    records on the domain - proves routing is enabled, nothing more.
 *  - Self-probe: the instance emails postey-probe+<nonce>@domain; the
 *    inbound worker records the nonce when the catch-all delivers it,
 *    proving the whole MX → Email Routing → catch-all → worker → D1 path.
 * Probe state lives in the settings kv table, shared with the inbound
 * worker; a verified stamp persists until a new probe replaces it. */

const probeKey = (domainId: string): string => `receiving_probe:${domainId}`;

interface ProbeState {
  nonce: string;
  sent_at: number;
  received_at: number | null;
}

interface ProbeView {
  status: 'none' | 'pending' | 'verified';
  sent_at?: number;
  received_at?: number;
}

async function readProbe(c: { env: Bindings }, domainId: string): Promise<ProbeView> {
  const row = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(probeKey(domainId))
    .first<{ value: string }>();
  if (!row) return { status: 'none' };
  try {
    const state = JSON.parse(row.value) as ProbeState;
    return state.received_at
      ? { status: 'verified', sent_at: state.sent_at, received_at: state.received_at }
      : { status: 'pending', sent_at: state.sent_at };
  } catch {
    return { status: 'none' };
  }
}

app.get('/inbox/receiving/:domainId', async c => {
  const domain = await c.env.DB.prepare('SELECT id, name, status FROM domains WHERE id = ?')
    .bind(c.req.param('domainId'))
    .first<{ id: string; name: string; status: string }>();
  if (!domain) return c.json({ error: 'Domain not found' }, 404);
  const [dns, probe] = await Promise.all([routingDnsChecks(domain.name), readProbe(c, domain.id)]);
  return c.json({ data: { domain: domain.name, dns, probe } });
});

app.post('/inbox/receiving/:domainId/probe', async c => {
  if (!c.env.EMAIL) {
    return c.json({ error: 'This instance predates probes - run an update from postey.app.' }, 501);
  }
  const domain = await c.env.DB.prepare('SELECT id, name, status FROM domains WHERE id = ?')
    .bind(c.req.param('domainId'))
    .first<{ id: string; name: string; status: string }>();
  if (!domain) return c.json({ error: 'Domain not found' }, 404);
  if (domain.status !== 'active') {
    return c.json({ error: `${domain.name} is not active - the probe is a real send from it` }, 409);
  }

  /* Write the nonce BEFORE sending so the inbound worker can never win the
   * race; restore the previous state (e.g. an old verified stamp) if the
   * send itself is refused. */
  const prev = await c.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(probeKey(domain.id))
    .first<{ value: string }>();
  const state: ProbeState = { nonce: randomHex(8), sent_at: Date.now(), received_at: null };
  await c.env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
    .bind(probeKey(domain.id), JSON.stringify(state))
    .run();

  try {
    await c.env.EMAIL.send({
      to: [`postey-probe+${state.nonce}@${domain.name}`],
      from: `postey-probe@${domain.name}`,
      subject: `Postey receiving probe ${state.nonce}`,
      text: 'Automated probe verifying that Email Routing delivers this domain\'s mail to the Postey inbound worker. It is consumed by the worker and never stored as mail.',
    });
  } catch (raw) {
    const err = raw as Error & { code?: string };
    if (prev) {
      await c.env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?')
        .bind(prev.value, probeKey(domain.id))
        .run();
    } else {
      await c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(probeKey(domain.id)).run();
    }
    return c.json({ error: `Probe send failed - ${err.code ?? 'E_UNKNOWN'}: ${err.message ?? ''}` }, 502);
  }

  await c.env.DB.prepare(
    'INSERT INTO quota_usage (day, sent) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET sent = sent + 1'
  )
    .bind(new Date().toISOString().slice(0, 10))
    .run();
  return c.json({ data: { status: 'pending', sent_at: state.sent_at } });
});

/* ── messages ────────────────────────────────────────────────────── */

app.get('/inbox/messages', async c => {
  const addressId = c.req.query('address_id');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
  const rows = addressId
    ? await c.env.DB.prepare(
        `SELECT m.id, m.address_id, m.from_email, m.from_name, m.to_email, m.subject, m.snippet,
                m.reply_to_message_id, m.read_at, m.created_at
         FROM inbox_messages m WHERE m.address_id = ? ORDER BY m.created_at DESC LIMIT ?`
      )
        .bind(addressId, limit)
        .all()
    : await c.env.DB.prepare(
        `SELECT m.id, m.address_id, m.from_email, m.from_name, m.to_email, m.subject, m.snippet,
                m.reply_to_message_id, m.read_at, m.created_at
         FROM inbox_messages m ORDER BY m.created_at DESC LIMIT ?`
      )
        .bind(limit)
        .all();
  return c.json({ data: rows.results });
});

app.get('/inbox/messages/:id', async c => {
  const row = await c.env.DB.prepare('SELECT * FROM inbox_messages WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{
      id: string;
      address_id: string;
      from_email: string;
      from_name: string | null;
      to_email: string;
      subject: string;
      body_r2_key: string | null;
      message_id_header: string | null;
      reply_to_message_id: string | null;
      read_at: number | null;
      created_at: number;
    }>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  const body = row.body_r2_key ? await c.env.BODIES.get(row.body_r2_key) : null;
  const content = body
    ? ((await body.json()) as {
        html: string | null;
        text: string | null;
        attachments?: InboxAttachment[];
      })
    : { html: null, text: null, attachments: [] };

  /* Parent outbound send, for the thread view. */
  const parent = row.reply_to_message_id
    ? await c.env.DB.prepare(
        'SELECT id, subject, status, from_email, to_json, created_at, sent_at FROM messages WHERE id = ?'
      )
        .bind(row.reply_to_message_id)
        .first()
    : null;

  /* Replies we already sent from the dashboard to this inbound mail. */
  const ourReplies = await c.env.DB.prepare(
    `SELECT id, subject, status, created_at FROM messages WHERE in_reply_to_inbox_id = ? ORDER BY created_at`
  )
    .bind(row.id)
    .all()
    .catch(() => ({ results: [] }));

  if (!row.read_at) {
    await c.env.DB.prepare('UPDATE inbox_messages SET read_at = ? WHERE id = ?')
      .bind(Date.now(), row.id)
      .run();
  }

  return c.json({
    data: {
      ...row,
      read_at: row.read_at ?? Date.now(),
      html: content.html,
      text: content.text,
      attachments: (content.attachments ?? []).map(({ key: _key, ...meta }) => meta),
      parent,
      our_replies: ourReplies.results,
    },
  });
});

/** Stream one inbound attachment - index addresses the manifest in the body
 *  JSON, same contract as the outbound /messages/:id/attachments/:idx. */
app.get('/inbox/messages/:id/attachments/:idx', async c => {
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx > 19) return c.json({ error: 'Not found' }, 404);
  const row = await c.env.DB.prepare('SELECT body_r2_key FROM inbox_messages WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ body_r2_key: string | null }>();
  if (!row?.body_r2_key) return c.json({ error: 'Not found' }, 404);
  const bodyObj = await c.env.BODIES.get(row.body_r2_key);
  if (!bodyObj) return c.json({ error: 'Not found' }, 404);
  const manifest = ((await bodyObj.json()) as { attachments?: InboxAttachment[] }).attachments?.[idx];
  if (!manifest) return c.json({ error: 'Not found' }, 404);
  const file = await c.env.BODIES.get(manifest.key);
  if (!file) return c.json({ error: 'Not found' }, 404);
  // Only images may render in place (cid: references); anything else - HTML,
  // SVG, PDFs - downloads, so hostile mail can't render on this origin.
  const inline = manifest.disposition === 'inline' && /^image\/(?!svg)/i.test(manifest.type);
  return new Response(file.body, {
    headers: {
      'Content-Type': manifest.type || 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${manifest.filename.replaceAll('"', '')}"`,
      'Cache-Control': 'private, max-age=300',
      // Hostile mail must never script against the dashboard origin.
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

/* ── reply ───────────────────────────────────────────────────────── */

app.post(
  '/inbox/messages/:id/reply',
  zValidator(
    'json',
    z.object({
      html: z.string().max(500_000).nullish(),
      text: z.string().max(500_000).nullish(),
    })
  ),
  async c => {
    if (!c.env.EMAIL) {
      return c.json({ error: 'This instance predates replies - run an update from postey.app.' }, 501);
    }
    const input = c.req.valid('json');
    if (!input.html && !input.text) return c.json({ error: 'A reply body is required' }, 422);

    const inbound = await c.env.DB.prepare(
      `SELECT m.id, m.from_email, m.subject, m.message_id_header, a.local_part,
              d.id AS d_id, d.name AS domain_name, d.status AS domain_status
       FROM inbox_messages m
       JOIN inbox_addresses a ON a.id = m.address_id
       JOIN domains d ON d.id = a.domain_id
       WHERE m.id = ?`
    )
      .bind(c.req.param('id'))
      .first<{
        id: string;
        from_email: string;
        subject: string;
        message_id_header: string | null;
        local_part: string;
        d_id: string;
        domain_name: string;
        domain_status: string;
      }>();
    if (!inbound) return c.json({ error: 'Not found' }, 404);
    if (inbound.domain_status !== 'active') {
      return c.json({ error: `${inbound.domain_name} is not active - activate it to reply` }, 409);
    }

    const suppressed = await c.env.DB.prepare(
      'SELECT 1 FROM suppressions WHERE address = ? LIMIT 1'
    )
      .bind(inbound.from_email)
      .first();
    if (suppressed) {
      return c.json({ error: `${inbound.from_email} is on the suppression list` }, 409);
    }

    const fromEmail = `${inbound.local_part}@${inbound.domain_name}`;
    const subject = /^re:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`;
    const id = newId('msg');
    const now = Date.now();
    const bodyKey = `bodies/${id}.json`;
    /* Plain-text composer, but recipients' clients get a clean HTML part too. */
    const escapeHtml = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html =
      input.html ??
      (input.text
        ? `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(input.text)}</div>`
        : null);
    await c.env.BODIES.put(bodyKey, JSON.stringify({ html, text: input.text ?? null }));

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO messages (id, domain_id, api_key_id, from_email, from_name, to_json, reply_to,
           subject, body_r2_key, status, in_reply_to_inbox_id, created_at)
         VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, 'sending', ?, ?)`
      ).bind(
        id,
        inbound.d_id,
        fromEmail,
        JSON.stringify([inbound.from_email]),
        fromEmail,
        subject,
        bodyKey,
        inbound.id,
        now
      ),
      c.env.DB.prepare(
        "INSERT INTO message_recipients (message_id, address, kind, status, updated_at) VALUES (?, ?, 'to', 'queued', ?)"
      ).bind(id, inbound.from_email, now),
      c.env.DB.prepare(
        "INSERT INTO message_events (id, message_id, event, meta_json, created_at) VALUES (?, ?, 'queued', ?, ?)"
      ).bind(newId('evt'), id, JSON.stringify({ reply_to: inbound.id }), now),
    ]);

    try {
      const response = await c.env.EMAIL.send({
        to: [inbound.from_email],
        from: fromEmail,
        subject,
        ...(html ? { html } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(inbound.message_id_header
          ? {
              headers: {
                'In-Reply-To': inbound.message_id_header,
                References: inbound.message_id_header,
              },
            }
          : {}),
      });
      const done = Date.now();
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE messages SET status = 'sent', provider_message_id = ?, sent_at = ?, completed_at = ? WHERE id = ?"
        ).bind(response?.messageId ?? null, done, done, id),
        c.env.DB.prepare(
          "UPDATE message_recipients SET status = 'sent', updated_at = ? WHERE message_id = ?"
        ).bind(done, id),
        c.env.DB.prepare(
          "INSERT INTO message_events (id, message_id, event, meta_json, created_at) VALUES (?, ?, 'sent', NULL, ?)"
        ).bind(newId('evt'), id, done),
        c.env.DB.prepare(
          'INSERT INTO quota_usage (day, sent) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET sent = sent + 1'
        ).bind(new Date().toISOString().slice(0, 10)),
      ]);
      return c.json({ data: { id } });
    } catch (raw) {
      const err = raw as Error & { code?: string };
      const code = err.code ?? 'E_UNKNOWN';
      const done = Date.now();
      await c.env.DB.batch([
        c.env.DB.prepare(
          "UPDATE messages SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ?"
        ).bind(code, (err.message ?? '').slice(0, 500), done, id),
        c.env.DB.prepare(
          "UPDATE message_recipients SET status = 'failed', error = ?, updated_at = ? WHERE message_id = ?"
        ).bind(code, done, id),
      ]);
      return c.json({ error: `${code}: ${err.message ?? 'send failed'}` }, 502);
    }
  }
);

export const inboxRoute = app;
