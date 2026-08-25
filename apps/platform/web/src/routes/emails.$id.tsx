import { useState, type ReactElement } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { Badge, Card, Table } from '@/lib/ui';

export const Route = createFileRoute('/emails/$id')({
  component: EmailDetail,
});

interface MessageDetail {
  id: string;
  from_email: string;
  from_name: string | null;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null;
  reply_to: string | null;
  subject: string;
  status: string;
  template_id: string | null;
  provider_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  created_at: number;
  sent_at: number | null;
  completed_at: number | null;
  recipients: { address: string; kind: string; status: string; error: string | null }[];
  events: { event: string; meta_json: string | null; created_at: number }[];
  body: { html: string | null; text: string | null } | null;
}

function EmailDetail(): ReactElement {
  const { id } = Route.useParams();
  const [view, setView] = useState<'preview' | 'html' | 'text'>('preview');
  const query = useQuery({
    queryKey: ['message', id],
    queryFn: () => api.get<MessageDetail>(`/api/messages/${id}`),
  });
  const m = query.data;
  if (!m) return <p className="text-sm text-ink-soft">{query.isLoading ? 'Loading…' : 'Not found.'}</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link to="/emails" className="text-sm text-ink-soft hover:text-ink">
        ← Emails
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold">{m.subject}</h1>
          <p className="mt-1 font-mono text-xs text-ink-soft">{m.id}</p>
        </div>
        <Badge status={m.status} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Envelope">
          <dl className="space-y-2 text-sm">
            {[
              ['From', m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email],
              ['To', (JSON.parse(m.to_json) as string[]).join(', ')],
              ['Cc', m.cc_json ? (JSON.parse(m.cc_json) as string[]).join(', ') : null],
              ['Reply-To', m.reply_to],
              ['Template', m.template_id],
              ['Provider id', m.provider_message_id],
              ['Attempts', String(m.attempts)],
              ['Created', fmtTime(m.created_at)],
              ['Completed', fmtTime(m.completed_at)],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                    {k}
                  </dt>
                  <dd className="min-w-0 break-words">{v}</dd>
                </div>
              ))}
          </dl>
          {m.error_code && (
            <p className="mt-3 rounded-xl border border-bad/30 bg-bad/5 px-3 py-2 font-mono text-xs text-bad">
              {m.error_code}: {m.error_message}
            </p>
          )}
        </Card>

        <Card title="Timeline">
          <ol className="space-y-2 text-sm">
            {m.events.map((e, i) => (
              <li key={i} className="flex items-center gap-3">
                <Badge status={e.event === 'rate_limited' ? 'queued' : e.event} />
                <span className="text-xs text-ink-soft">{fmtTime(e.created_at)}</span>
                {e.meta_json && (
                  <span className="truncate font-mono text-xs text-ink-soft">{e.meta_json}</span>
                )}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card title="Recipients">
        <Table head={['Address', 'Kind', 'Status', 'Error']}>
          {m.recipients.map(r => (
            <tr key={r.address}>
              <td className="px-4 py-2.5">{r.address}</td>
              <td className="px-4 py-2.5 text-xs uppercase text-ink-soft">{r.kind}</td>
              <td className="px-4 py-2.5">
                <Badge status={r.status} />
              </td>
              <td className="px-4 py-2.5 font-mono text-xs text-ink-soft">{r.error ?? '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>

      {m.body && (
        <Card
          title="Body"
          action={
            <div className="flex gap-1 rounded-full border border-line p-0.5 text-xs font-semibold">
              {(['preview', 'html', 'text'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded-full px-3 py-1 ${view === v ? 'bg-ink text-cream' : 'text-ink-soft'}`}
                >
                  {v}
                </button>
              ))}
            </div>
          }
        >
          {view === 'preview' && m.body.html ? (
            <iframe
              title="preview"
              sandbox=""
              srcDoc={m.body.html}
              className="h-96 w-full rounded-xl border border-line bg-white"
            />
          ) : (
            <pre className="max-h-96 overflow-auto rounded-xl border border-line bg-white p-4 font-mono text-xs">
              {view === 'text' ? (m.body.text ?? '(no text part)') : (m.body.html ?? '(no html part)')}
            </pre>
          )}
        </Card>
      )}
    </div>
  );
}
