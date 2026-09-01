-- Inbox product: receiving addresses and stored inbound mail.
-- Addresses are rows here (the zone-level catch-all delivers everything;
-- the inbound worker accepts only registered local parts).

CREATE TABLE IF NOT EXISTS inbox_addresses (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  local_part TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (domain_id, local_part)
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT,
  body_r2_key TEXT,
  -- RFC 5322 Message-ID of the inbound mail (for reply threading headers).
  message_id_header TEXT,
  -- Outbound messages.id this mail replies to (matched via References).
  reply_to_message_id TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_address ON inbox_messages (address_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_messages_created ON inbox_messages (created_at DESC);

-- Outbound replies sent from the Inbox reference the inbound mail they answer.
ALTER TABLE messages ADD COLUMN in_reply_to_inbox_id TEXT;
