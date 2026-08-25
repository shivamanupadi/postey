-- Postey platform schema. Applied by the deploy wizard (one request per
-- migration; statements split on the breakpoint marker) and by
-- `wrangler d1 migrations apply` in local dev.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  zone_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  default_from TEXT,
  onboarded_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  domain_id TEXT REFERENCES domains(id),
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  api_key_id TEXT,
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT,
  bcc_json TEXT,
  reply_to TEXT,
  subject TEXT NOT NULL,
  body_r2_key TEXT,
  headers_json TEXT,
  template_id TEXT,
  tags_json TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  scheduled_at INTEGER,
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  completed_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem
  ON messages(api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_messages_list ON messages(created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_messages_domain ON messages(domain_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS message_recipients (
  message_id TEXT NOT NULL REFERENCES messages(id),
  address TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, address)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS message_events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  address TEXT,
  event TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_events_message ON message_events(message_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS suppressions (
  id TEXT PRIMARY KEY,
  domain_id TEXT REFERENCES domains(id),
  address TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_message_id TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressions_unique
  ON suppressions(COALESCE(domain_id, ''), address);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT,
  text TEXT,
  variables_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  last_attempt_at INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS quota_usage (
  day TEXT PRIMARY KEY,
  sent INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
