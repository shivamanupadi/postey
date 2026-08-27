/**
 * Email Sending event consumer - delivery truth.
 *
 * Cloudflare pushes lifecycle events (delivered / deferred / bounced /
 * failed / rejected / complained) for every message onto the instance's
 * events queue via a Queues event subscription. This consumer joins them
 * back to our messages, upgrades 'sent' (accepted by Cloudflare) into real
 * outcomes, feeds hard bounces and complaints into the suppression list,
 * and fires truthful outbound webhooks.
 *
 * Events are at-least-once: each carries an eventId we use as the
 * message_events primary key, so replays dedupe on the UNIQUE constraint.
 */
import { newId, type EventType } from '@postey/shared';
import type { Bindings } from './types';
import { dispatchWebhooks } from './deliver';

interface EmailSendingEvent {
  type?: string; // cf.email.sending.message.<kind>
  source?: { domain?: string };
  payload?: {
    eventId?: string;
    messageId?: string;
    sender?: string;
    recipient?: string;
    subject?: string;
    terminal?: boolean;
    delivery?: {
      status?: string;
      provider?: string;
      smtpStatusCode?: string;
      smtpResponse?: string;
    };
    bounce?: { type?: string };
  };
}

interface MatchedMessage {
  id: string;
  subject: string;
  from_email: string;
  tags_json: string | null;
}

const KIND_TO_EVENT: Record<string, EventType> = {
  delivered: 'delivered',
  deferred: 'deferred',
  bounced: 'bounced',
  failed: 'failed',
  rejected: 'rejected',
  complained: 'complained',
};

export async function handleEmailEvents(
  batch: MessageBatch<unknown>,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await handleOne(msg.body as EmailSendingEvent, env, ctx);
      msg.ack();
    } catch (err) {
      console.error('email event failed:', err);
      msg.retry({ delaySeconds: 60 });
    }
  }
}

/** Join an event to our message: provider id first (with and without the
 *  RFC 5322 angle brackets), then recipient+subject within a recent window. */
async function matchMessage(
  env: Bindings,
  ev: NonNullable<EmailSendingEvent['payload']>
): Promise<MatchedMessage | null> {
  const cols = 'id, subject, from_email, tags_json';
  if (ev.messageId) {
    const byId = await env.DB.prepare(
      `SELECT ${cols} FROM messages WHERE provider_message_id IN (?, ?, ?) LIMIT 1`
    )
      .bind(ev.messageId, `<${ev.messageId}>`, ev.messageId.replace(/^<|>$/g, ''))
      .first<MatchedMessage>();
    if (byId) return byId;
  }
  if (ev.recipient && ev.subject) {
    return env.DB.prepare(
      `SELECT m.id, m.subject, m.from_email, m.tags_json FROM messages m
       JOIN message_recipients r ON r.message_id = m.id
       WHERE r.address = ? AND m.subject = ? AND m.created_at > ?
       ORDER BY m.created_at DESC LIMIT 1`
    )
      .bind(ev.recipient.toLowerCase(), ev.subject, Date.now() - 72 * 3600 * 1000)
      .first<MatchedMessage>();
  }
  return null;
}

async function handleOne(
  event: EmailSendingEvent,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  const kind = event.type?.split('.').pop() ?? '';
  const mapped = KIND_TO_EVENT[kind];
  const payload = event.payload;
  if (!mapped || !payload) return; // unknown event shape - drop, never poison

  const message = await matchMessage(env, payload);
  if (!message) {
    console.warn(`email event ${kind} did not match a message`, payload.messageId, payload.recipient);
    return;
  }
  const recipient = payload.recipient?.toLowerCase() ?? null;
  const smtp = payload.delivery?.smtpResponse ?? payload.delivery?.smtpStatusCode ?? null;
  const now = Date.now();

  /* Dedupe on Cloudflare's eventId (at-least-once delivery). */
  const eventRowId = payload.eventId ? `evt_cf_${payload.eventId}` : newId('evt');
  try {
    await env.DB.prepare(
      'INSERT INTO message_events (id, message_id, address, event, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(
        eventRowId,
        message.id,
        recipient,
        mapped,
        JSON.stringify({
          ...(smtp ? { smtp } : {}),
          ...(payload.delivery?.provider ? { provider: payload.delivery.provider } : {}),
          ...(payload.bounce?.type ? { bounce: payload.bounce.type } : {}),
        }),
        now
      )
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return; // replay
    throw err;
  }

  /* Per-recipient status. Complaints keep 'delivered' (the mail arrived). */
  const recipientStatus =
    mapped === 'delivered'
      ? 'delivered'
      : mapped === 'bounced'
        ? 'bounced'
        : mapped === 'failed'
          ? 'failed'
          : mapped === 'rejected'
            ? 'suppressed'
            : null;
  if (recipient && recipientStatus) {
    await env.DB.prepare(
      'UPDATE message_recipients SET status = ?, error = ?, updated_at = ? WHERE message_id = ? AND address = ?'
    )
      .bind(recipientStatus, mapped === 'delivered' ? null : smtp, now, message.id, recipient)
      .run();
    await rollUpMessageStatus(env, message.id, now);
  }

  /* Suppression: dead addresses and complainers, instance-wide. */
  if (recipient && (mapped === 'complained' || (mapped === 'bounced' && payload.bounce?.type !== 'soft'))) {
    await env.DB.prepare(
      'INSERT INTO suppressions (id, domain_id, address, reason, source_message_id, created_at) VALUES (?, NULL, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
    )
      .bind(newId('sup'), recipient, mapped === 'complained' ? 'complaint' : 'hard_bounce', message.id, now)
      .run();
  }

  /* Truthful webhooks for terminal outcomes; deferrals stay log-only. */
  if (mapped !== 'deferred') {
    await dispatchWebhooks(env, ctx, message, mapped, {
      ...(recipient ? { recipient } : {}),
      ...(smtp ? { detail: smtp } : {}),
    });
  }
}

/** All recipients settled → message status reflects the worst/best outcome. */
async function rollUpMessageStatus(env: Bindings, messageId: string, now: number): Promise<void> {
  const rows = (
    await env.DB.prepare('SELECT status, COUNT(*) AS n FROM message_recipients WHERE message_id = ? GROUP BY status')
      .bind(messageId)
      .all<{ status: string; n: number }>()
  ).results;
  const count = (s: string): number => rows.find(r => r.status === s)?.n ?? 0;
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const delivered = count('delivered');
  const negative = count('bounced') + count('failed');
  let status: string | null = null;
  if (delivered === total) status = 'delivered';
  else if (delivered > 0 && negative > 0) status = 'partial';
  else if (negative > 0 && count('sent') === 0 && count('queued') === 0) {
    status = count('bounced') > 0 ? 'bounced' : 'failed';
  }
  if (status) {
    await env.DB.prepare(
      "UPDATE messages SET status = ?, completed_at = ? WHERE id = ? AND status IN ('sent', 'partial', 'delivered', 'bounced')"
    )
      .bind(status, now, messageId)
      .run();
  }
}
