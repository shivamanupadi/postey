import type { EmailBinding } from '@postey/shared';

export type Bindings = {
  DB: D1Database;
  BODIES: R2Bucket;
  EMAIL: EmailBinding;
  ENVIRONMENT: string;
};
