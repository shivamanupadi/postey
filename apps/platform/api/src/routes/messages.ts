/** Email log + overview stats. */
import { Hono } from 'hono';
import type { Bindings, Variables } from '../types';

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.get('/overview', async c => {
  const now = Date.now();
  const dayStart = new Date().toISOString().slice(0, 10);
  const [today, week, byStatus, suppressions, domains, quota] = await Promise.all([
    c.env.DB.prepare('SELECT sent, rejected FROM quota_usage WHERE day = ?')
      .bind(dayStart)
      .first<{ sent: number; rejected: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at > ?')
      .bind(now - 7 * 86_400_000)
      .first<{ n: number }>(),
    c.env.DB.prepare(
      'SELECT status, COUNT(*) AS n FROM messages WHERE created_at > ? GROUP BY status'
    )
      .bind(now - 7 * 86_400_000)
      .all<{ status: string; n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM suppressions').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM domains WHERE status = ?')
      .bind('active')
      .first<{ n: number }>(),
    c.env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('quota_daily_limit')
      .first<{ value: string }>(),
  ]);
  return c.json({
    data: {
      sentToday: today?.sent ?? 0,
      rejectedToday: today?.rejected ?? 0,
      last7d: week?.n ?? 0,
      byStatus: Object.fromEntries(byStatus.results.map(r => [r.status, r.n])),
      suppressions: suppressions?.n ?? 0,
      activeDomains: domains?.n ?? 0,
      quotaDailyLimit: quota ? Number(quota.value) : null,
    },
  });
});

app.get('/messages', async c => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
  const before = Number(c.req.query('before') ?? Date.now() + 60_000);
  const status = c.req.query('status');
  const q = c.req.query('q');
  const where: string[] = ['m.created_at < ?'];
  const binds: unknown[] = [before];
  if (status) {
    where.push('m.status = ?');
    binds.push(status);
  }
  if (q) {
    where.push('(m.subject LIKE ? OR m.to_json LIKE ? OR m.from_email LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  binds.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.from_email, m.from_name, m.to_json, m.subject, m.status, m.error_code,
            m.template_id, m.created_at, m.completed_at,
            (SELECT COUNT(*) FROM message_recipients r WHERE r.message_id = m.id) AS recipient_count
     FROM messages m WHERE ${where.join(' AND ')}
     ORDER BY m.created_at DESC LIMIT ?`
  )
    .bind(...binds)
    .all();
  const results = rows.results as { created_at: number }[];
  return c.json({
    data: results,
    nextBefore: results.length === limit ? results[results.length - 1].created_at : null,
  });
});

app.get('/messages/:id', async c => {
  const id = c.req.param('id');
  const message = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!message) return c.json({ error: 'Not found' }, 404);
  const [recipients, events] = await Promise.all([
    c.env.DB.prepare(
      'SELECT address, kind, status, error, updated_at FROM message_recipients WHERE message_id = ?'
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      'SELECT event, address, meta_json, created_at FROM message_events WHERE message_id = ? ORDER BY created_at'
    )
      .bind(id)
      .all(),
  ]);
  let body: { html: string | null; text: string | null } | null = null;
  if (message.body_r2_key) {
    const obj = await c.env.BODIES.get(String(message.body_r2_key));
    if (obj) body = (await obj.json()) as { html: string | null; text: string | null };
  }
  return c.json({
    data: { ...message, recipients: recipients.results, events: events.results, body },
  });
});

/* Stream one stored attachment. The index addresses the manifest in the body
 * JSON, which supplies filename and content type. */
app.get('/messages/:id/attachments/:idx', async c => {
  const id = c.req.param('id');
  const idx = Number(c.req.param('idx'));
  if (!Number.isInteger(idx) || idx < 0 || idx > 9) return c.json({ error: 'Not found' }, 404);
  const message = await c.env.DB.prepare('SELECT body_r2_key FROM messages WHERE id = ?')
    .bind(id)
    .first<{ body_r2_key: string | null }>();
  if (!message?.body_r2_key) return c.json({ error: 'Not found' }, 404);
  const bodyObj = await c.env.BODIES.get(message.body_r2_key);
  if (!bodyObj) return c.json({ error: 'Not found' }, 404);
  const manifest = (
    (await bodyObj.json()) as {
      attachments?: { key: string; filename: string; type: string }[];
    }
  ).attachments?.[idx];
  if (!manifest) return c.json({ error: 'Not found' }, 404);
  const file = await c.env.BODIES.get(manifest.key);
  if (!file) return c.json({ error: 'Not found' }, 404);
  return new Response(file.body, {
    headers: {
      'Content-Type': manifest.type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${manifest.filename.replaceAll('"', '')}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
});

export const messagesRoute = app;
