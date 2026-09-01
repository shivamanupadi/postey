/** Inbox product API: addresses, stored inbound mail, and replies.
 *  Replies deliver inline through the EMAIL binding and are recorded in the
 *  outbound messages log like any send. */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { newId } from '@postey/shared';
import type { Bindings, Variables } from '../types';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
    if (local_part.toLowerCase().startsWith('unsubscribe')) {
      return c.json({ error: 'unsubscribe@ is reserved for the suppression handler' }, 409);
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
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM inbox_messages WHERE address_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM inbox_addresses WHERE id = ?').bind(id),
  ]);
  return c.json({ data: { ok: true } });
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
    ? ((await body.json()) as { html: string | null; text: string | null })
    : { html: null, text: null };

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
    data: { ...row, read_at: row.read_at ?? Date.now(), html: content.html, text: content.text, parent, our_replies: ourReplies.results },
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
    await c.env.BODIES.put(
      bodyKey,
      JSON.stringify({ html: input.html ?? null, text: input.text ?? null })
    );

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
        ...(input.html ? { html: input.html } : {}),
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
