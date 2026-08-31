/**
 * Inline delivery - a single attempt through Cloudflare Email Service, made
 * in the request path. There is no send queue: the caller gets Cloudflare's
 * real answer. Transient conditions (daily cap, rate limit, internal errors)
 * surface as HTTP errors for the caller to retry - a retried request with the
 * same idempotency key re-attempts the previously failed message instead of
 * replaying the failure. Delivery truth (delivered / bounced / complained)
 * still arrives asynchronously via the events queue (events.ts).
 */
import { newId, signWebhook, type EventType, type WebhookEvent } from '@postey/shared';
import type { Bindings } from './types';

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

/** All we need from an execution context (Hono's and the runtime's both fit). */
interface WaitCtx {
  waitUntil(promise: Promise<unknown>): void;
}

const secondsToUtcMidnight = (): number => {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - Date.now()) / 1000));
};

export interface DeliverArgs {
  id: string;
  domainId: string;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  subject: string;
  headers: Record<string, string> | null;
  tagsJson: string | null;
  /** Live (unsuppressed) recipients only. */
  lists: { to: string[]; cc: string[]; bcc: string[] };
  html: string | null;
  text: string | null;
  attachments?: {
    content: ArrayBuffer;
    filename: string;
    type: string;
    disposition: string;
    contentId?: string;
  }[];
}

export type DeliverOutcome =
  | { kind: 'sent' }
  | { kind: 'suppressed'; code: string }
  | { kind: 'error'; http: 422 | 429 | 502; code: string; message: string; retryAfter?: number };

export async function deliverNow(
  env: Bindings,
  ctx: WaitCtx,
  args: DeliverArgs
): Promise<DeliverOutcome> {
  const { lists } = args;
  const day = today();
  const webhookRow = {
    id: args.id,
    subject: args.subject,
    from_email: args.fromEmail,
    tags_json: args.tagsJson,
  };

  try {
    const response = await env.EMAIL.send({
      to: lists.to.length ? lists.to : lists.cc.length ? lists.cc : lists.bcc,
      ...(lists.to.length && lists.cc.length ? { cc: lists.cc } : {}),
      ...(lists.bcc.length && (lists.to.length || lists.cc.length) ? { bcc: lists.bcc } : {}),
      from: { email: args.fromEmail, ...(args.fromName ? { name: args.fromName } : {}) },
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      subject: args.subject,
      ...(args.html ? { html: args.html } : {}),
      ...(args.text ? { text: args.text } : {}),
      ...(args.headers ? { headers: args.headers } : {}),
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    });

    // 'sent' = accepted by Cloudflare. The real outcome (delivered / bounced /
    // complained) arrives asynchronously via the Email Sending event
    // subscription and is applied in events.ts.
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE messages SET status = 'sent', provider_message_id = ?, sent_at = ?, completed_at = ?, error_code = NULL, error_message = NULL WHERE id = ?"
      ).bind(response?.messageId ?? null, now, now, args.id),
      env.DB.prepare(
        "UPDATE message_recipients SET status = 'sent', updated_at = ? WHERE message_id = ? AND status = 'queued'"
      ).bind(now, args.id),
      env.DB.prepare(
        'INSERT INTO quota_usage (day, sent) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET sent = sent + 1'
      ).bind(day),
      eventStmt(env, args.id, 'sent', null),
    ]);
    await dispatchWebhooks(env, ctx, webhookRow, 'sent');
    return { kind: 'sent' };
  } catch (raw) {
    const err = raw as Error & { code?: string };
    const code = err.code ?? 'E_UNKNOWN';

    if (code === 'E_DAILY_LIMIT_EXCEEDED') {
      await env.DB.prepare(
        'INSERT INTO quota_usage (day, rejected) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET rejected = rejected + 1'
      )
        .bind(day)
        .run();
      await setStatus(env, args.id, 'failed', code, err.message);
      await dispatchWebhooks(env, ctx, webhookRow, 'failed');
      return {
        kind: 'error',
        http: 429,
        code,
        message: 'Cloudflare daily sending limit reached - retry after midnight UTC',
        retryAfter: secondsToUtcMidnight(),
      };
    }

    if (code === 'E_RATE_LIMIT_EXCEEDED') {
      await setStatus(env, args.id, 'failed', code, err.message);
      return {
        kind: 'error',
        http: 429,
        code,
        message: 'Cloudflare sending rate limit reached - retry shortly',
        retryAfter: 300,
      };
    }

    if (code === 'E_RECIPIENT_SUPPRESSED') {
      // Cloudflare's own suppression list refused a recipient. With one
      // recipient we know exactly who - mirror it into our list.
      const now = Date.now();
      const only = [...lists.to, ...lists.cc, ...lists.bcc];
      if (only.length === 1) {
        await env.DB.prepare(
          'INSERT INTO suppressions (id, domain_id, address, reason, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
        )
          .bind(newId('sup'), null, only[0], 'hard_bounce', args.id, now)
          .run();
      }
      await setStatus(env, args.id, 'suppressed', code, err.message);
      await dispatchWebhooks(env, ctx, webhookRow, 'suppressed');
      return { kind: 'suppressed', code };
    }

    if (PERMANENT_CODES.has(code)) {
      if (code === 'E_SENDER_NOT_VERIFIED' || code === 'E_SENDER_DOMAIN_NOT_AVAILABLE') {
        await env.DB.prepare("UPDATE domains SET status = 'pending' WHERE id = ?")
          .bind(args.domainId)
          .run()
          .catch(() => undefined);
      }
      await setStatus(env, args.id, 'failed', code, err.message);
      await dispatchWebhooks(env, ctx, webhookRow, 'failed');
      return { kind: 'error', http: 422, code, message: err.message };
    }

    /* E_DELIVERY_FAILED, E_INTERNAL_SERVER_ERROR, unknown: the caller retries
     * (safely, thanks to idempotency keys re-attempting failed messages). */
    await setStatus(env, args.id, 'failed', code, err.message);
    await dispatchWebhooks(env, ctx, webhookRow, 'failed');
    return { kind: 'error', http: 502, code, message: err.message };
  }
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
  messageId: string,
  status: string,
  code: string | null,
  message: string | null
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE messages SET status = ?, error_code = ?, error_message = ?, completed_at = ? WHERE id = ?'
    ).bind(status, code, message ? message.slice(0, 500) : null, now, messageId),
    env.DB.prepare(
      "UPDATE message_recipients SET status = ?, error = ?, updated_at = ? WHERE message_id = ? AND status IN ('queued')"
    ).bind(status, code, now, messageId),
    eventStmt(
      env,
      messageId,
      status === 'suppressed' ? 'suppressed' : 'failed',
      code ? JSON.stringify({ code }) : null
    ),
  ]);
}

/* ── outbound webhooks ───────────────────────────────────────────── */

export async function dispatchWebhooks(
  env: Bindings,
  ctx: WaitCtx,
  row: { id: string; subject: string; from_email: string; tags_json: string | null },
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
