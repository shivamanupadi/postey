/** Structural type for the Email Service send_email binding - kept minimal so
 *  the release bundle does not depend on generated worker-configuration types. */
export interface EmailBinding {
  send(message: {
    to: string | string[];
    cc?: string[];
    bcc?: string[];
    from: { email: string; name?: string } | string;
    replyTo?: string;
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
    attachments?: {
      /** Strings are RAW content (not base64); binary goes as ArrayBuffer. */
      content: string | ArrayBuffer;
      filename: string;
      type?: string;
      disposition?: string;
      contentId?: string;
    }[];
  }): Promise<{ messageId?: string }>;
}

export interface QueueJob {
  messageId: string;
}

export type Bindings = {
  DB: D1Database;
  BODIES: R2Bucket;
  SEND_QUEUE: Queue<QueueJob>;
  EMAIL: EmailBinding;
  ENVIRONMENT: string;
};
