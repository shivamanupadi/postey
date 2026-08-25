/**
 * Postey inbound worker - Email Routing handler for replies and unsubscribes.
 *
 * Route mail here with an Email Routing rule on your sending domain. Two jobs:
 *  1. unsubscribe@<domain> (and List-Unsubscribe one-click posts routed as
 *     mail) suppress the sender for future sends.
 *  2. Everything else is forwarded to the verified address configured in
 *     settings.inbound_forward, when one is set.
 */
import { newId } from '@postey/shared';

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
};

export default {
  async email(message: ForwardableEmailMessage, env: Bindings): Promise<void> {
    const to = message.to.toLowerCase();
    const from = message.from.toLowerCase();
    const localPart = to.split('@')[0];

    if (localPart === 'unsubscribe' || localPart.startsWith('unsubscribe+')) {
      await env.DB.prepare(
        'INSERT INTO suppressions (id, domain_id, address, reason, created_at) VALUES (?, NULL, ?, ?, ?) ON CONFLICT DO NOTHING'
      )
        .bind(newId('sup'), from, 'unsubscribe', Date.now())
        .run()
        .catch(err => console.error('unsubscribe suppression failed:', err));
      return; // acknowledged; no forward for unsubscribe mail
    }

    const forward = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('inbound_forward')
      .first<{ value: string }>()
      .catch(() => null);
    if (forward?.value) {
      try {
        await message.forward(forward.value);
        return;
      } catch (err) {
        console.error(`forward to ${forward.value} failed:`, err);
      }
    }
    // No forward configured (or it failed): reject so the sender learns the
    // mailbox is unattended instead of the message silently vanishing.
    message.setReject('This address is not monitored');
  },
};
