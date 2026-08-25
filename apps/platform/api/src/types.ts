export type Bindings = {
  DB: D1Database;
  BODIES: R2Bucket;
  ASSETS?: Fetcher;
  ENVIRONMENT: string;
  SEND_URL?: string;
  POSTEY_VERSION?: string;
  DEPLOY_INSTANCE_ID?: string;
  SENDING_DOMAIN?: string;
  /** One-time code the first sign-up must present (set by the wizard). */
  CLAIM_TOKEN?: string;
};

export type SessionUser = { id: string; email: string };

export type Variables = {
  user?: SessionUser;
};
