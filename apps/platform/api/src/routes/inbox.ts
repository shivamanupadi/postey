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

interface InboundListRow {
  id: string;
  address_id: string;
  from_email: string;
  from_name: string | null;
  to_email: string;
  subject: string;
  snippet: string | null;
  reply_to_message_id: string | null;
  read_at: number | null;
  created_at: number;
}

app.get('/inbox/messages', async c => {
  const addressId = c.req.query('address_id');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
  const inboundRows = addressId
    ? await c.env.DB.prepare(
        `SELECT m.id, m.address_id, m.from_email, m.from_name, m.to_email, m.subject, m.snippet,
                m.reply_to_message_id, m.read_at, m.created_at
         FROM inbox_messages m WHERE m.address_id = ? ORDER BY m.created_at DESC LIMIT ?`
      )
        .bind(addressId, limit)
        .all<InboundListRow>()
    : await c.env.DB.prepare(
        `SELECT m.id, m.address_id, m.from_email, m.from_name, m.to_email, m.subject, m.snippet,
                m.reply_to_message_id, m.read_at, m.created_at
         FROM inbox_messages m ORDER BY m.created_at DESC LIMIT ?`
      )
        .bind(limit)
        .all<InboundListRow>();

  /* Threads STARTED from the Inbox (dashboard-composed: api_key_id NULL, not
   * a reply) show as sent rows until the first answer arrives - after that
   * the inbound row represents the conversation. */
  const sentFilter = addressId ? 'AND a.id = ?' : '';
  const sentRows = await c.env.DB.prepare(
    `SELECT m.id, a.id AS address_id, m.from_email, m.to_json, m.subject, m.status, m.created_at
     FROM messages m
     JOIN domains d ON d.id = m.domain_id
     JOIN inbox_addresses a ON a.domain_id = d.id AND m.from_email = a.local_part || '@' || d.name
     WHERE m.api_key_id IS NULL AND m.in_reply_to_inbox_id IS NULL ${sentFilter}
       AND NOT EXISTS (SELECT 1 FROM inbox_messages im WHERE im.reply_to_message_id = m.id)
     ORDER BY m.created_at DESC LIMIT ?`
  )
    .bind(...(addressId ? [addressId, limit] : [limit]))
    .all<{ id: string; address_id: string; from_email: string; to_json: string; subject: string; status: string; created_at: number }>();

  const rows = [
    ...inboundRows.results.map(r => ({ ...r, status: null as string | null, direction: 'inbound' as const })),
    ...sentRows.results.map(r => ({
      id: r.id,
      address_id: r.address_id,
      from_email: r.from_email,
      from_name: null,
      to_email: (JSON.parse(r.to_json || '[]') as string[])[0] ?? '',
      subject: r.subject,
      snippet: null,
      reply_to_message_id: null,
      read_at: r.created_at, // sent rows are never "unread"
      created_at: r.created_at,
      status: r.status,
      direction: 'outbound' as const,
    })),
  ]
    .sort((a, b) => Number(b.created_at) - Number(a.created_at))
    .slice(0, limit);
  return c.json({ data: rows });
});

/* ── conversations ───────────────────────────────────────────────────
 * Dashboard flavor of the send worker's thread walker: any id in the
 * chain (msg_ or inb_) expands to the whole exchange, chronological,
 * bodies and attachments included. Reading marks inbound mail read. */

app.get('/inbox/conversations/:id', async c => {
  const seed = c.req.param('id');
  const msgIds = new Set<string>();
  const inbIds = new Set<string>();
  if (seed.startsWith('inb')) inbIds.add(seed);
  else msgIds.add(seed);

  for (let round = 0; round < 10; round++) {
    const before = msgIds.size + inbIds.size;
    if (before > 50) break;
    if (msgIds.size > 0) {
      const marks = [...msgIds].map(() => '?').join(', ');
      const kids = await c.env.DB.prepare(
        `SELECT id FROM inbox_messages WHERE reply_to_message_id IN (${marks})`
      ).bind(...msgIds).all<{ id: string }>();
      for (const r of kids.results) inbIds.add(r.id);
      const parents = await c.env.DB.prepare(
        `SELECT in_reply_to_inbox_id AS link FROM messages WHERE id IN (${marks}) AND in_reply_to_inbox_id IS NOT NULL`
      ).bind(...msgIds).all<{ link: string }>();
      for (const r of parents.results) inbIds.add(r.link);
    }
    if (inbIds.size > 0) {
      const marks = [...inbIds].map(() => '?').join(', ');
      const kids = await c.env.DB.prepare(
        `SELECT id FROM messages WHERE in_reply_to_inbox_id IN (${marks})`
      ).bind(...inbIds).all<{ id: string }>();
      for (const r of kids.results) msgIds.add(r.id);
      const parents = await c.env.DB.prepare(
        `SELECT reply_to_message_id AS link FROM inbox_messages WHERE id IN (${marks}) AND reply_to_message_id IS NOT NULL`
      ).bind(...inbIds).all<{ link: string }>();
      for (const r of parents.results) msgIds.add(r.link);
    }
    if (msgIds.size + inbIds.size === before) break;
  }

  const loadBody = async (
    key: string | null
  ): Promise<{ html: string | null; text: string | null; attachments?: InboxAttachment[] }> => {
    if (!key) return { html: null, text: null };
    const obj = await c.env.BODIES.get(key).catch(() => null);
    if (!obj) return { html: null, text: null };
    try {
      return (await obj.json()) as {
        html: string | null;
        text: string | null;
        attachments?: InboxAttachment[];
      };
    } catch {
      return { html: null, text: null };
    }
  };

  const outbound =
    msgIds.size > 0
      ? (
          await c.env.DB.prepare(
            `SELECT id, from_email, to_json, subject, status, body_r2_key, created_at, sent_at
             FROM messages WHERE id IN (${[...msgIds].map(() => '?').join(', ')})`
          ).bind(...msgIds).all<Record<string, unknown>>()
        ).results
      : [];
  const inbound =
    inbIds.size > 0
      ? (
          await c.env.DB.prepare(
            `SELECT id, address_id, from_email, from_name, to_email, subject, body_r2_key, read_at, created_at
             FROM inbox_messages WHERE id IN (${[...inbIds].map(() => '?').join(', ')})`
          ).bind(...inbIds).all<Record<string, unknown>>()
        ).results
      : [];
  if (outbound.length + inbound.length === 0) return c.json({ error: 'Not found' }, 404);

  const entries = await Promise.all([
    ...outbound.map(async r => {
      const body = await loadBody(r.body_r2_key as string | null);
      return {
        kind: 'outbound' as const,
        id: r.id as string,
        from: r.from_email as string,
        to: JSON.parse((r.to_json as string) ?? '[]') as string[],
        subject: r.subject as string,
        status: r.status as string,
        text: body.text,
        html: body.html,
        attachments: (body.attachments ?? []).map(({ key: _k, ...meta }, index) => ({ index, ...meta })),
        created_at: r.created_at as number,
      };
    }),
    ...inbound.map(async r => {
      const body = await loadBody(r.body_r2_key as string | null);
      return {
        kind: 'inbound' as const,
        id: r.id as string,
        from: r.from_email as string,
        from_name: r.from_name as string | null,
        to: [r.to_email as string],
        subject: r.subject as string,
        text: body.text,
        html: body.html,
        attachments: (body.attachments ?? []).map(({ key: _k, ...meta }, index) => ({ index, ...meta })),
        read_at: r.read_at as number | null,
        created_at: r.created_at as number,
      };
    }),
  ]);
  entries.sort((a, b) => Number(a.created_at) - Number(b.created_at));

  /* Which inbox address is "our side", and who is the counterpart? */
  const firstInbound = inbound[0];
  const ourAddress = firstInbound
    ? (firstInbound.to_email as string)
    : ((outbound[0]?.from_email as string) ?? null);
  const addressRow = ourAddress
    ? await c.env.DB.prepare(
        `SELECT a.id FROM inbox_addresses a JOIN domains d ON d.id = a.domain_id
         WHERE a.local_part || '@' || d.name = ?`
      ).bind(ourAddress).first<{ id: string }>()
    : null;
  const counterpart = firstInbound
    ? (firstInbound.from_email as string)
    : ((JSON.parse((outbound[0]?.to_json as string) ?? '[]') as string[])[0] ?? null);

  const unread = inbound.filter(r => !r.read_at).map(r => r.id as string);
  if (unread.length > 0) {
    await c.env.DB.prepare(
      `UPDATE inbox_messages SET read_at = ? WHERE id IN (${unread.map(() => '?').join(', ')}) AND read_at IS NULL`
    )
      .bind(Date.now(), ...unread)
      .run()
      .catch(() => undefined);
  }

  return c.json({
    data: {
      seed,
      subject: entries[0]?.subject ?? '(no subject)',
      our_address: ourAddress,
      address_id: addressRow?.id ?? null,
      counterpart,
      had_unread: unread.length > 0,
      messages: entries,
    },
  });
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

/* ── outgoing attachments (compose + reply) ──────────────────────── */

const attachmentsInput = z
  .array(
    z.object({
      filename: z.string().min(1).max(255),
      content: z.string().min(1), // base64
      content_type: z.string().max(255).optional(),
    })
  )
  .max(10)
  .optional();

interface DecodedFile {
  filename: string;
  type: string;
  bytes: Uint8Array;
}

/** Base64 → bytes with the send-side 4 MiB total cap. */
function decodeAttachments(
  input: { filename: string; content: string; content_type?: string }[] | undefined
): DecodedFile[] | { error: string } {
  const files: DecodedFile[] = [];
  let total = 0;
  for (const att of input ?? []) {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(att.content), ch => ch.charCodeAt(0));
    } catch {
      return { error: `${att.filename}: content is not valid base64` };
    }
    total += bytes.byteLength;
    if (total > 4 * 1024 * 1024) return { error: 'Attachments exceed the 4 MiB total limit' };
    files.push({ filename: att.filename, type: att.content_type || 'application/octet-stream', bytes });
  }
  return files;
}

/** Blobs beside the body, manifest inside it - the layout the email-log
 *  attachment routes already serve. */
async function storeAttachments(
  bodies: R2Bucket,
  messageId: string,
  files: DecodedFile[]
): Promise<InboxAttachment[]> {
  const manifest: InboxAttachment[] = [];
  for (const [i, f] of files.entries()) {
    const key = `bodies/${messageId}/att/${i}`;
    await bodies.put(key, f.bytes, { httpMetadata: { contentType: f.type } });
    manifest.push({
      key,
      filename: f.filename,
      type: f.type,
      size: f.bytes.byteLength,
      disposition: 'attachment',
      content_id: null,
    });
  }
  return manifest;
}

/* Mirror the send worker's proven shape EXACTLY: the real Email Service
 * requires disposition ('inline' | 'attachment') on every attachment -
 * omitting it fails with E_VALIDATION_ERROR (the local simulated binding
 * accepts anything, which is how this slipped through). */
const emailAttachments = (files: DecodedFile[]): object =>
  files.length
    ? {
        attachments: files.map(f => ({
          content: f.bytes.buffer.slice(
            f.bytes.byteOffset,
            f.bytes.byteOffset + f.bytes.byteLength
          ) as ArrayBuffer,
          filename: f.filename,
          type: f.type,
          disposition: 'attachment',
        })),
      }
    : {};

/* ── compose ─────────────────────────────────────────────────────────
 * A fresh send from an inbox address - no thread history. Delivers the
 * same way replies do (inline through EMAIL, recorded in the outbound
 * log); answers thread back into the Inbox automatically because the
 * inbound worker matches References against provider_message_id. */

app.post(
  '/inbox/compose',
  zValidator(
    'json',
    z.object({
      address_id: z.string().min(1),
      to: z.array(z.string().email()).min(1).max(10),
      subject: z.string().min(1).max(998),
      text: z.string().min(1).max(500_000),
      attachments: attachmentsInput,
    })
  ),
  async c => {
    if (!c.env.EMAIL) {
      return c.json({ error: 'This instance predates compose - run an update from postey.app.' }, 501);
    }
    const input = c.req.valid('json');
    const address = await c.env.DB.prepare(
      `SELECT a.local_part, d.id AS d_id, d.name AS domain_name, d.status AS domain_status
       FROM inbox_addresses a JOIN domains d ON d.id = a.domain_id WHERE a.id = ?`
    )
      .bind(input.address_id)
      .first<{ local_part: string; d_id: string; domain_name: string; domain_status: string }>();
    if (!address) return c.json({ error: 'Address not found' }, 404);
    if (address.domain_status !== 'active') {
      return c.json({ error: `${address.domain_name} is not active - activate it to send` }, 409);
    }

    const recipients = [...new Set(input.to.map(t => t.toLowerCase()))];
    const suppressed = await c.env.DB.prepare(
      `SELECT address FROM suppressions WHERE address IN (${recipients.map(() => '?').join(', ')}) LIMIT 1`
    )
      .bind(...recipients)
      .first<{ address: string }>();
    if (suppressed) {
      return c.json({ error: `${suppressed.address} is on the suppression list` }, 409);
    }

    const files = decodeAttachments(input.attachments);
    if ('error' in files) return c.json({ error: files.error }, 422);

    const fromEmail = `${address.local_part}@${address.domain_name}`;
    const id = newId('msg');
    const now = Date.now();
    const bodyKey = `bodies/${id}.json`;
    const escapeHtml = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(input.text)}</div>`;

    const manifest = await storeAttachments(c.env.BODIES, id, files);
    await c.env.BODIES.put(
      bodyKey,
      JSON.stringify({ html, text: input.text, ...(manifest.length ? { attachments: manifest } : {}) })
    );

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO messages (id, domain_id, api_key_id, from_email, from_name, to_json, reply_to,
           subject, body_r2_key, status, created_at)
         VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, 'sending', ?)`
      ).bind(id, address.d_id, fromEmail, JSON.stringify(recipients), fromEmail, input.subject, bodyKey, now),
      ...recipients.map(r =>
        c.env.DB.prepare(
          "INSERT INTO message_recipients (message_id, address, kind, status, updated_at) VALUES (?, ?, 'to', 'queued', ?)"
        ).bind(id, r, now)
      ),
      c.env.DB.prepare(
        "INSERT INTO message_events (id, message_id, event, meta_json, created_at) VALUES (?, ?, 'queued', ?, ?)"
      ).bind(newId('evt'), id, JSON.stringify({ composed_from: input.address_id }), now),
    ]);

    try {
      const response = await c.env.EMAIL.send({
        to: recipients,
        from: fromEmail,
        subject: input.subject,
        html,
        text: input.text,
        ...emailAttachments(files),
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

/* ── reply ───────────────────────────────────────────────────────── */

app.post(
  '/inbox/messages/:id/reply',
  zValidator(
    'json',
    z.object({
      html: z.string().max(500_000).nullish(),
      text: z.string().max(500_000).nullish(),
      attachments: attachmentsInput,
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
    const files = decodeAttachments(input.attachments);
    if ('error' in files) return c.json({ error: files.error }, 422);
    const manifest = await storeAttachments(c.env.BODIES, id, files);
    await c.env.BODIES.put(
      bodyKey,
      JSON.stringify({
        html,
        text: input.text ?? null,
        ...(manifest.length ? { attachments: manifest } : {}),
      })
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
        ...(html ? { html } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...emailAttachments(files),
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
