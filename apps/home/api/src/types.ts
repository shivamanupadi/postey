export type Bindings = {
  /** Deploy-wizard registry - sessions only, never tokens. */
  DB: D1Database;
  /** Release artifacts (worker bundles, web assets) the wizard provisions from. */
  RELEASES: R2Bucket;
  ENVIRONMENT: string;
  /** "Sign in with Cloudflare" OAuth client (Doppler postey-home, prod only -
   *  absent means the wizard falls back to token paste). */
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_CLIENT_SECRET?: string;
  /** IP-scoped abuse guards (prod only; absent in local dev). */
  VERIFY_LIMIT?: RateLimit;
  SESSION_LIMIT?: RateLimit;
};

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface InstanceRow {
  id: string;
  status: 'new' | 'deploying' | 'ready' | 'failed' | 'destroyed';
  account_id: string | null;
  instance_name: string | null;
  api_url: string | null;
  send_url: string | null;
  sending_domain: string | null; // JSON: { zoneId, zoneName, subdomain }
  deployed_version: string | null;
  error: string | null;
  steps: string | null; // JSON: StepEvent[]
  created_at: number;
  updated_at: number;
}

export interface SendingDomainChoice {
  zoneId: string;
  zoneName: string;
  subdomain: string;
}
