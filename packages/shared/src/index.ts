import { z } from 'zod';

/* ── ids ─────────────────────────────────────────────────────────── */

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── send API (Resend-compatible surface) ────────────────────────── */

/** "Name <a@b.c>" or bare address or {email,name} - normalized by parseAddress. */
const addressInput = z.union([
  z.string().min(3).max(320),
  z.object({ email: z.string().email(), name: z.string().max(200).optional() }),
]);

const recipients = z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]);

export const sendEmailSchema = z.object({
  from: addressInput,
  to: recipients,
  cc: recipients.optional(),
  bcc: recipients.optional(),
  reply_to: z.union([z.string().email(), z.array(z.string().email()).max(1)]).optional(),
  /** Optional when template_id is set and the template supplies one. */
  subject: z.string().min(1).max(998).optional(),
  html: z.string().max(2_000_000).optional(),
  text: z.string().max(2_000_000).optional(),
  headers: z.record(z.string().max(2048)).optional(),
  template_id: z.string().max(64).optional(),
  variables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  tags: z
    .array(z.object({ name: z.string().max(64), value: z.string().max(256) }))
    .max(10)
    .optional(),
  /** Resend-compatible: base64 content. Total decoded size capped at 4 MiB
   *  (Cloudflare's 5 MiB message limit, minus room for headers + body). */
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        content: z.string().min(1).max(5_600_000),
        content_type: z.string().max(200).optional(),
        disposition: z.enum(['attachment', 'inline']).optional(),
        content_id: z.string().max(200).optional(),
      })
    )
    .max(10)
    .optional(),
  idempotency_key: z.string().max(256).optional(),
});

export type SendEmailInput = z.infer<typeof sendEmailSchema>;

export interface ParsedAddress {
  email: string;
  name?: string;
}

/** Accepts "Name <a@b.c>", "a@b.c", or {email,name}. Returns null when invalid. */
export function parseAddress(input: z.infer<typeof addressInput>): ParsedAddress | null {
  if (typeof input === 'object') return { email: input.email.toLowerCase(), name: input.name };
  const match = input.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (match) {
    const name = match[1]?.trim();
    return { email: match[2].toLowerCase(), ...(name ? { name } : {}) };
  }
  const bare = input.trim();
  if (/^[^<>\s]+@[^<>\s]+\.[^<>\s]+$/.test(bare)) return { email: bare.toLowerCase() };
  return null;
}

export function toList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map(v => v.toLowerCase());
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Attachment manifest entry stored in the body JSON; binary lives in R2. */
export interface StoredAttachment {
  key: string;
  filename: string;
  type: string;
  disposition: 'attachment' | 'inline';
  content_id: string | null;
  size: number;
}

/** Minimal {{var}} template rendering - no logic, just substitution. */
export function renderTemplate(
  source: string,
  variables: Record<string, string | number | boolean>
): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key: string) => {
    const value = variables[key];
    return value === undefined ? '' : String(value);
  });
}

/* ── statuses & events ───────────────────────────────────────────── */

export const MESSAGE_STATUSES = [
  'queued',
  'scheduled',
  'sending',
  /** Accepted by Cloudflare; real delivery outcome arrives via events. */
  'sent',
  'delivered',
  'partial',
  'bounced',
  'failed',
  'suppressed',
  'canceled',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const EVENT_TYPES = [
  'queued',
  'attempted',
  'sent',
  'delivered',
  'deferred',
  'bounced',
  'complained',
  'rejected',
  'failed',
  'suppressed',
  'rate_limited',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SUPPRESSION_REASONS = ['hard_bounce', 'complaint', 'manual', 'unsubscribe'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Outbound webhook payload shape (signed with Postey-Signature: sha256=<hmac>). */
export interface WebhookEvent {
  type: `email.${EventType}`;
  created_at: string;
  data: {
    message_id: string;
    recipient?: string;
    subject?: string;
    from?: string;
    tags?: { name: string; value: string }[];
    detail?: string;
  };
}

export async function signWebhook(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

/* ── quota settings keys (settings table) ────────────────────────── */

export const SETTING_KEYS = {
  /** Discovered CF daily cap - set when a send returns E_DAILY_LIMIT_EXCEEDED. */
  quotaDailyLimit: 'quota_daily_limit',
  /** Days to keep message bodies in R2 (metadata stays in D1). */
  retentionDays: 'retention_days',
  defaultFrom: 'default_from',
  /** Verified address inbound mail gets forwarded to (optional). */
  inboundForward: 'inbound_forward',
} as const;
