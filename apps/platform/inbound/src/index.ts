/**
 * Postey inbound worker - Email Routing handler.
 *
 * The deploy wizard points a zone-level catch-all rule here. Three jobs:
 *  1. unsubscribe@<domain> (and List-Unsubscribe one-click posts routed as
 *     mail) suppress the sender for future sends.
 *  2. Mail to a REGISTERED inbox address (inbox_addresses) is parsed, stored
 *     (metadata in D1, body in R2), threaded to the outbound message it
 *     replies to via References headers, and announced with an
 *     email.reply.received webhook.
 *  3. Everything else is rejected so senders learn the mailbox is unattended.
 */
import PostalMime from 'postal-mime';
import { newId, signWebhook, type WebhookEvent } from '@postey/shared';

type Bindings = {
  DB: D1Database;
  BODIES: R2Bucket;
  ENVIRONMENT: string;
};

export default {
  async email(message: ForwardableEmailMessage, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const to = message.to.toLowerCase();
    const from = message.from.toLowerCase();
    const [localPart, toDomain] = [to.split('@')[0], to.split('@')[1]];

    /* Receiving-verification probes (dashboard "Verify receiving") loop a
     * nonce through the real MX → routing → catch-all → worker path. Record
     * the receipt and drop the mail - probes are infrastructure, not inbox.
     * Never rejected: a bounce would tell outsiders the probe scheme exists,
     * and a mismatched nonce (stale or guessed) simply proves nothing. */
    if (localPart.startsWith('postey-probe')) {
      await recordProbeReceipt(env, toDomain, localPart.replace(/^postey-probe\+?/, ''));
      return;
    }

    if (localPart === 'unsubscribe' || localPart.startsWith('unsubscribe+')) {
      await env.DB.prepare(
        'INSERT INTO suppressions (id, domain_id, address, reason, created_at) VALUES (?, NULL, ?, ?, ?) ON CONFLICT DO NOTHING'
      )
        .bind(newId('sup'), from, 'unsubscribe', Date.now())
        .run()
        .catch(err => console.error('unsubscribe suppression failed:', err));
      return; // acknowledged; no forward for unsubscribe mail
    }

    const address = await env.DB.prepare(
      `SELECT a.id, a.domain_id FROM inbox_addresses a
       JOIN domains d ON d.id = a.domain_id
       WHERE d.name = ? AND a.local_part = ?`
    )
      .bind(toDomain, localPart)
      .first<{ id: string; domain_id: string }>()
      .catch(() => null);
    if (!address) {
      message.setReject('This address is not monitored');
      return;
    }

    try {
      await storeInbound(message, env, ctx, { to, from, address });
    } catch (err) {
      // A parse/store failure must not bounce real mail into the void
      // silently - reject with a retryable-looking message so the sender's
      // server retries later.
      console.error('inbound store failed:', err);
      message.setReject('Temporary processing failure, please retry');
    }
  },
};

async function storeInbound(
  message: ForwardableEmailMessage,
  env: Bindings,
  ctx: ExecutionContext,
  meta: { to: string; from: string; address: { id: string; domain_id: string } }
): Promise<void> {
  const parsed = await PostalMime.parse(message.raw);
  const now = Date.now();
  const id = newId('inb');

  const text = parsed.text ?? null;
  const html = parsed.html ?? null;
  const snippet = (text ?? stripTags(html ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  /* Thread to the outbound send this replies to: any id in References /
   * In-Reply-To that matches a provider_message_id we recorded. */
  const refIds = [
    ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
    ...(parsed.references ? parsed.references.split(/\s+/) : []),
  ]
    .map(r => r.trim())
    .filter(Boolean)
    .slice(0, 10);
  let parentId: string | null = null;
  for (const ref of refIds) {
    const bare = ref.replace(/^<|>$/g, '');
    const hit = await env.DB.prepare(
      'SELECT id FROM messages WHERE provider_message_id IN (?, ?, ?) LIMIT 1'
    )
      .bind(ref, `<${bare}>`, bare)
      .first<{ id: string }>();
    if (hit) {
      parentId = hit.id;
      break;
    }
  }

  /* Attachments: blobs as separate R2 objects, manifest in the body JSON -
   * the same layout the send worker uses for outbound mail. Email Routing
   * caps messages at 25MB, so no extra size policing here. */
  const attachments: {
    key: string;
    filename: string;
    type: string;
    size: number;
    disposition: string;
    content_id: string | null;
  }[] = [];
  for (const [i, att] of (parsed.attachments ?? []).entries()) {
    if (i >= 20) break; // manifest stays bounded; 20 parts is already absurd
    const key = `inbox/${id}/att/${i}`;
    const content = typeof att.content === 'string' ? new TextEncoder().encode(att.content) : att.content;
    try {
      await env.BODIES.put(key, content, {
        httpMetadata: { contentType: att.mimeType || 'application/octet-stream' },
      });
      attachments.push({
        key,
        filename: att.filename || `attachment-${i + 1}`,
        type: att.mimeType || 'application/octet-stream',
        size: content.byteLength,
        disposition: att.disposition === 'inline' ? 'inline' : 'attachment',
        content_id: att.contentId?.replace(/^<|>$/g, '') ?? null,
      });
    } catch (err) {
      console.error(`attachment ${i} store failed:`, err);
    }
  }

  const bodyKey = `inbox/${id}.json`;
  await env.BODIES.put(bodyKey, JSON.stringify({ html, text, attachments }));

  await env.DB.prepare(
    `INSERT INTO inbox_messages (id, address_id, domain_id, from_email, from_name, to_email,
       subject, snippet, body_r2_key, message_id_header, reply_to_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      meta.address.id,
      meta.address.domain_id,
      parsed.from?.address?.toLowerCase() ?? meta.from,
      parsed.from?.name || null,
      meta.to,
      parsed.subject ?? '(no subject)',
      snippet || null,
      bodyKey,
      parsed.messageId ?? null,
      parentId,
      now
    )
    .run();

  /* Full-fidelity webhook: receivers get the parsed text (capped) and the
   * attachment manifest inline, so acting on a reply needs no fetch back.
   * html stays behind GET /api/replies/:id - it can be arbitrarily large. */
  const webhookText = text ?? (html ? stripTags(html).replace(/\s+/g, ' ').trim() : '');
  await dispatchReplyWebhook(env, ctx, {
    reply_id: id,
    from: parsed.from?.address?.toLowerCase() ?? meta.from,
    to: meta.to,
    subject: parsed.subject ?? '(no subject)',
    ...(parentId ? { message_id: parentId } : {}),
    text: webhookText.slice(0, 20_000),
    ...(webhookText.length > 20_000 ? { text_truncated: true } : {}),
    attachments: attachments.map((a, index) => ({
      index,
      filename: a.filename,
      type: a.type,
      size: a.size,
    })),
  });
}

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, ' ');

/** Mark the pending receiving probe for this domain as delivered - but only
 *  when the nonce matches what the api worker wrote to settings, so stray or
 *  guessed probe mail can't stamp a domain verified. */
async function recordProbeReceipt(env: Bindings, domainName: string, nonce: string): Promise<void> {
  if (!nonce) return;
  try {
    const row = await env.DB.prepare(
      `SELECT s.key, s.value FROM settings s
       JOIN domains d ON s.key = 'receiving_probe:' || d.id
       WHERE d.name = ?`
    )
      .bind(domainName)
      .first<{ key: string; value: string }>();
    if (!row) return;
    const state = JSON.parse(row.value) as { nonce?: string; received_at?: number | null };
    if (state.nonce !== nonce || state.received_at) return;
    await env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?')
      .bind(JSON.stringify({ ...state, received_at: Date.now() }), row.key)
      .run();
  } catch (err) {
    console.error('probe receipt failed:', err);
  }
}

/** Signed email.reply.received webhooks - same contract as the send worker's
 *  dispatcher (Postey-Signature HMAC of the raw body). */
async function dispatchReplyWebhook(
  env: Bindings,
  ctx: ExecutionContext,
  data: WebhookEvent['data']
): Promise<void> {
  const hooks = (
    await env.DB.prepare('SELECT id, url, secret, events_json FROM webhooks WHERE enabled = 1').all<{
      id: string;
      url: string;
      secret: string;
      events_json: string;
    }>()
  ).results.filter(h => {
    try {
      const events = JSON.parse(h.events_json) as string[];
      return events.includes('email.reply.received') || events.includes('*');
    } catch {
      return false;
    }
  });
  if (hooks.length === 0) return;

  const payload: WebhookEvent = {
    type: 'email.reply.received',
    created_at: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);

  ctx.waitUntil(
    Promise.all(
      hooks.map(async hook => {
        let responseCode: number | null = null;
        let ok = false;
        for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
          try {
            const res = await fetch(hook.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Postey-Signature': await signWebhook(hook.secret, body),
                'Postey-Event': payload.type,
              },
              body,
              signal: AbortSignal.timeout(10_000),
            });
            responseCode = res.status;
            ok = res.ok;
          } catch {
            responseCode = null;
          }
          if (!ok && attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
        }
        await env.DB.prepare(
          'INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status, attempts, response_code, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(newId('whd'), hook.id, newId('evt'), payload.type, ok ? 'delivered' : 'failed', ok ? 1 : 3, responseCode, Date.now())
          .run()
          .catch(() => undefined);
      })
    )
  );
}
