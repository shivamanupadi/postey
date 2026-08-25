-- Deploy-wizard registry - the ONLY table in the postey.app database. Tracks
-- wizard deployments into USER accounts. Never stores tokens - only
-- non-sensitive resume state.
CREATE TABLE IF NOT EXISTS deploy_instances (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'new',
  account_id TEXT,
  instance_name TEXT,
  api_url TEXT,
  send_url TEXT,
  sending_domain TEXT,
  deployed_version TEXT,
  error TEXT,
  steps TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
