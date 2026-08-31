/**
 * Queue consumer: the delivery pipeline.
 *
 * Cloudflare's daily sending cap is reputation-gated and unpublished, so the
 * consumer treats it as DISCOVERED state: an E_DAILY_LIMIT_EXCEEDED response
 * records today's sent count as the working limit (settings.quota_daily_limit)
 * and the job is re-enqueued for later - an email past the quota stretches
 * out, it never fails. Re-enqueues use a fresh queue message (not retry()) so
 * quota waits never consume the transient-error retry budget.
 */
import {
  newId,
  signWebhook,
  type EventType,
  type StoredAttachment,
  type WebhookEvent,
} from '@postey/shared';
import type { Bindings, QueueJob } from './types';

interface MessageRow {
  id: string;
  domain_id: string;
  from_email: string;
  from_name: string | null;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null;
  reply_to: string | null;
  subject: string;
  body_r2_key: string | null;
  headers_json: string | null;
  tags_json: string | null;
  status: string;
  scheduled_at: number | null;
  attempts: number;
}

const TERMINAL = new Set(['delivered', 'partial', 'bounced', 'failed', 'suppressed', 'canceled']);
const MAX_QUOTA_WAITS = 48; // x1h - a job stuck a full two days past quota fails loudly
const PERMANENT_CODES = new Set([
  'E_VALIDATION_ERROR',
  'E_FIELD_MISSING',
  'E_TOO_MANY_RECIPIENTS',
  'E_SENDER_NOT_VERIFIED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_CONTENT_TOO_LARGE',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
]);

const today = (): string => new Date().toISOString().slice(0, 10);

export async function deliverBatch(
  batch: MessageBatch<QueueJob>,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await deliverOne(msg, env, ctx);
    } catch (err) {
      console.error(`deliver ${msg.body.messageId} attempt ${msg.attempts} failed:`, err);
      msg.retry({ delaySeconds: Math.min(60 * msg.attempts, 600) });
    }
  }
}

async function deliverOne(
  msg: Message<QueueJob>,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  const { messageId } = msg.body;
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?')
    .bind(messageId)
    .first<MessageRow>();
  if (!row || TERMINAL.has(row.status)) {
    msg.ack();
    return;
  }

  /* Clock skew on scheduled sends: the producer delay lands slightly early. */
  if (row.scheduled_at && row.scheduled_at > Date.now() + 5000) {
    const wait = Math.min(Math.ceil((row.scheduled_at - Date.now()) / 1000), 43200);
    await env.SEND_QUEUE.send({ messageId }, { delaySeconds: wait });
    msg.ack();
    return;
  }

  /* Quota pacing against the discovered daily cap. */
  const day = today();
  const [limitRow, usageRow] = await Promise.all([
    env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('quota_daily_limit')
      .first<{ value: string }>(),
    env.DB.prepare('SELECT sent FROM quota_usage WHERE day = ?')
      .bind(day)
      .first<{ sent: number }>(),
  ]);
  const limit = limitRow ? Number(limitRow.value) : null;
  const sentToday = usageRow?.sent ?? 0;
  if (limit && sentToday >= limit) {
    await requeueForQuota(env, row, msg, 'daily quota reached (discovered limit)');
    return;
  }

  /* Recipients still in play. */
  const recipients = (
    await env.DB.prepare(
      "SELECT address, kind FROM message_recipients WHERE message_id = ? AND status IN ('queued')"
    )
      .bind(messageId)
      .all<{ address: string; kind: 'to' | 'cc' | 'bcc' }>()
  ).results;
  if (recipients.length === 0) {
    await setStatus(env, row, 'suppressed', null, null);
    msg.ack();
    return;
  }

  const body = row.body_r2_key ? await env.BODIES.get(row.body_r2_key) : null;
  const content = body
    ? ((await body.json()) as {
        html: string | null;
        text: string | null;
        attachments?: StoredAttachment[];
      })
    : { html: null, text: null };

  /* Load attachment binaries from R2. A missing object is a hard failure -
   * silently sending without a promised attachment would be worse. */
  let attachments:
    | { content: ArrayBuffer; filename: string; type: string; disposition: string; contentId?: string }[]
    | undefined;
  if (content.attachments?.length) {
    attachments = [];
    for (const meta of content.attachments) {
      const obj = await env.BODIES.get(meta.key);
      if (!obj) {
        await setStatus(env, row, 'failed', 'E_ATTACHMENT_MISSING', `${meta.filename} not in storage`);
        msg.ack();
        return;
      }
      attachments.push({
        content: await obj.arrayBuffer(),
        filename: meta.filename,
        type: meta.type,
        disposition: meta.disposition,
        ...(meta.content_id ? { contentId: meta.content_id } : {}),
      });
    }
  }

  await env.DB.prepare("UPDATE messages SET status = 'sending', attempts = attempts + 1 WHERE id = ?")
    .bind(messageId)
    .run();

  const lists = { to: [] as string[], cc: [] as string[], bcc: [] as string[] };
  for (const r of recipients) lists[r.kind].push(r.address);

  try {
    const response = await env.EMAIL.send({
      to: lists.to.length ? lists.to : lists.cc.length ? lists.cc : lists.bcc,
      ...(lists.to.length && lists.cc.length ? { cc: lists.cc } : {}),
      ...(lists.bcc.length && (lists.to.length || lists.cc.length) ? { bcc: lists.bcc } : {}),
      from: { email: row.from_email, ...(row.from_name ? { name: row.from_name } : {}) },
      ...(row.reply_to ? { replyTo: row.reply_to } : {}),
      subject: row.subject,
      ...(content.html ? { html: content.html } : {}),
      ...(content.text ? { text: content.text } : {}),
      ...(row.headers_json ? { headers: JSON.parse(row.headers_json) } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });

    // 'sent' = accepted by Cloudflare. The real outcome (delivered / bounced /
    // complained) arrives asynchronously via the Email Sending event
    // subscription and is applied in events.ts.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE messages SET status = 'sent', provider_message_id = ?, sent_at = ?, completed_at = ?, error_code = NULL, error_message = NULL WHERE id = ?"
      ).bind(response?.messageId ?? null, now, now, messageId),
      env.DB.prepare(
        "UPDATE message_recipients SET status = 'sent', updated_at = ? WHERE message_id = ? AND status = 'queued'"
      ).bind(now, messageId),
      env.DB.prepare(
        'INSERT INTO quota_usage (day, sent) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET sent = sent + 1'
      ).bind(day),
      eventStmt(env, messageId, 'sent', null),
    ]);
    await dispatchWebhooks(env, ctx, row, 'sent');
    msg.ack();
  } catch (raw) {
    const err = raw as Error & { code?: string };
    const code = err.code ?? 'E_UNKNOWN';

    if (code === 'E_DAILY_LIMIT_EXCEEDED') {
      // Learn the cap: today's successful count IS the effective limit.
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('quota_daily_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(String(Math.max(sentToday, 1))),
        env.DB.prepare(
          'INSERT INTO quota_usage (day, rejected) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET rejected = rejected + 1'
        ).bind(day),
      ]);
      await requeueForQuota(env, row, msg, 'Cloudflare daily sending limit reached');
      return;
    }

    if (code === 'E_RATE_LIMIT_EXCEEDED') {
      await env.DB.prepare("UPDATE messages SET status = 'queued' WHERE id = ?")
        .bind(messageId)
        .run();
      await env.SEND_QUEUE.send({ messageId }, { delaySeconds: 300 });
      msg.ack();
      return;
    }

    if (code === 'E_RECIPIENT_SUPPRESSED') {
      // Cloudflare's own suppression list refused a recipient. With one
      // recipient we know exactly who - mirror it into our list.
      const now = Date.now();
      if (recipients.length === 1) {
        await env.DB.prepare(
          'INSERT INTO suppressions (id, domain_id, address, reason, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
        )
          .bind(newId('sup'), null, recipients[0].address, 'hard_bounce', messageId, now)
          .run();
      }
      await setStatus(env, row, 'suppressed', code, err.message);
      await dispatchWebhooks(env, ctx, row, 'suppressed');
      msg.ack();
      return;
    }

    if (code === 'E_DELIVERY_FAILED') {
      if (msg.attempts >= 5) {
        await setStatus(env, row, 'bounced', code, err.message);
        await dispatchWebhooks(env, ctx, row, 'bounced');
        msg.ack();
      } else {
        msg.retry({ delaySeconds: Math.min(120 * msg.attempts, 900) });
      }
      return;
    }

    if (PERMANENT_CODES.has(code)) {
      if (code === 'E_SENDER_NOT_VERIFIED' || code === 'E_SENDER_DOMAIN_NOT_AVAILABLE') {
        await env.DB.prepare("UPDATE domains SET status = 'pending' WHERE id = ?")
          .bind(row.domain_id)
          .run()
          .catch(() => undefined);
      }
      await setStatus(env, row, 'failed', code, err.message);
      await dispatchWebhooks(env, ctx, row, 'failed');
      msg.ack();
      return;
    }

    /* Unknown / E_INTERNAL_SERVER_ERROR: transient until the retry budget runs out. */
    if (msg.attempts >= 5) {
      await setStatus(env, row, 'failed', code, err.message);
      await dispatchWebhooks(env, ctx, row, 'failed');
      msg.ack();
    } else {
      await env.DB.prepare("UPDATE messages SET status = 'queued' WHERE id = ?")
        .bind(messageId)
        .run();
      msg.retry({ delaySeconds: Math.min(60 * msg.attempts, 600) });
    }
  }
}

async function requeueForQuota(
  env: Bindings,
  row: MessageRow,
  msg: Message<QueueJob>,
  reason: string
): Promise<void> {
  if (row.attempts >= MAX_QUOTA_WAITS) {
    await setStatus(env, row, 'failed', 'E_QUOTA_WAIT_EXHAUSTED', reason);
    msg.ack();
    return;
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET status = 'queued', attempts = attempts + 1 WHERE id = ?"
    ).bind(row.id),
    eventStmt(env, row.id, 'rate_limited', JSON.stringify({ reason })),
  ]);
  await env.SEND_QUEUE.send({ messageId: row.id }, { delaySeconds: 3600 });
  msg.ack();
}

function eventStmt(
  env: Bindings,
  messageId: string,
  event: EventType,
  meta: string | null
): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO message_events (id, message_id, event, meta_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(newId('evt'), messageId, event, meta, Date.now());
}

async function setStatus(
  env: Bindings,
  row: MessageRow,
  status: string,
  code: string | null,
  message: string | null
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE messages SET status = ?, error_code = ?, error_message = ?, completed_at = ? WHERE id = ?'
    ).bind(status, code, message ? message.slice(0, 500) : null, now, row.id),
    env.DB.prepare(
      "UPDATE message_recipients SET status = ?, error = ?, updated_at = ? WHERE message_id = ? AND status IN ('queued')"
    ).bind(status === 'delivered' ? 'delivered' : status, code, now, row.id),
    eventStmt(
      env,
      row.id,
      status === 'bounced'
        ? 'bounced'
        : status === 'suppressed'
          ? 'suppressed'
          : status === 'delivered'
            ? 'delivered'
            : 'failed',
      code ? JSON.stringify({ code }) : null
    ),
  ]);
}

/* ── outbound webhooks ───────────────────────────────────────────── */

export async function dispatchWebhooks(
  env: Bindings,
  ctx: ExecutionContext,
  row: Pick<MessageRow, 'id' | 'subject' | 'from_email' | 'tags_json'>,
  event: EventType,
  extra?: { recipient?: string; detail?: string }
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
      return events.includes(`email.${event}`) || events.includes('*');
    } catch {
      return false;
    }
  });
  if (hooks.length === 0) return;

  const payload: WebhookEvent = {
    type: `email.${event}`,
    created_at: new Date().toISOString(),
    data: {
      message_id: row.id,
      subject: row.subject,
      from: row.from_email,
      ...(extra?.recipient ? { recipient: extra.recipient } : {}),
      ...(extra?.detail ? { detail: extra.detail } : {}),
      ...(row.tags_json ? { tags: JSON.parse(row.tags_json) } : {}),
    },
  };
  const body = JSON.stringify(payload);

  ctx.waitUntil(
    Promise.all(
      hooks.map(async hook => {
        const eventId = newId('evt');
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
          .bind(newId('whd'), hook.id, eventId, payload.type, ok ? 'delivered' : 'failed', ok ? 1 : 3, responseCode, Date.now())
          .run()
          .catch(() => undefined);
      })
    )
  );
}
