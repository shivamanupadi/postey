import { lazy, Suspense, useState, type ReactElement, type ReactNode } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Paperclip } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import { Badge, Card, Segmented, Table } from '@/lib/ui';

const CodeEditor = lazy(() => import('@/lib/code-editor'));

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
  events: { event: string; address: string | null; meta_json: string | null; created_at: number }[];
  body: {
    html: string | null;
    text: string | null;
    attachments?: { filename: string; type: string; size: number; disposition: string }[];
  } | null;
}

const fmtSize = (bytes: number): string =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Compact one-liner out of an event's meta_json ({smtp, provider, reason, …}). */
const metaLine = (raw: string | null): string | null => {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    const parts = Object.entries(m)
      .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
      .map(([k, v]) => (k === 'smtp' || k === 'reason' ? String(v) : `${k}: ${String(v)}`));
    return parts.length ? parts.join(' · ').slice(0, 160) : null;
  } catch {
    return raw.slice(0, 160);
  }
};

const EVENT_TONE: Record<string, string> = {
  delivered: 'bg-ok',
  sent: 'bg-ok',
  queued: 'bg-warn',
  scheduled: 'bg-warn',
  deferred: 'bg-warn',
  rate_limited: 'bg-warn',
  bounced: 'bg-bad',
  complained: 'bg-bad',
  rejected: 'bg-bad',
  failed: 'bg-bad',
};

function CopyId({ id }: { id: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold transition ${
        copied
          ? 'border-accent/30 bg-accent-soft text-accent-deep'
          : 'border-line-soft bg-card text-ink-soft hover:text-ink'
      }`}
    >
      {copied ? 'Copied ✓' : 'Copy id'}
    </button>
  );
}

function Kv({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <>
      <dt className="whitespace-nowrap text-xs font-medium text-ink-soft">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-xs text-ink">{children}</dd>
    </>
  );
}

function EmailDetail(): ReactElement {
  const { id } = Route.useParams();
  const [view, setView] = useState<'preview' | 'html' | 'text'>('preview');
  const query = useQuery({
    queryKey: ['message', id],
    queryFn: () => api.get<MessageDetail>(`/api/messages/${id}`),
  });
  const m = query.data;
  if (!m)
    return (
      <p className="text-sm text-ink-soft">{query.isLoading ? 'Loading…' : 'Not found.'}</p>
    );

  const events = [...m.events].reverse();
  const latestMetaFor = (address: string): string | null =>
    metaLine(events.find(e => e.address?.toLowerCase() === address.toLowerCase())?.meta_json ?? null);

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        to="/emails"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-soft transition hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Emails
      </Link>

      <div className="mb-5 mt-2.5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[21px] font-semibold text-ink">{m.subject}</h1>
          <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-ink-soft">
            {m.id}
            <CopyId id={m.id} />
          </div>
        </div>
        <div className="pt-1">
          <Badge status={m.status} />
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* main column */}
        <div className="space-y-4">
          <Card
            title="Body"
            action={
              <Segmented
                options={['preview', 'html', 'text'] as const}
                value={view}
                onChange={setView}
              />
            }
          >
            {m.body ? (
              view === 'preview' && m.body.html ? (
                <iframe
                  title="preview"
                  sandbox=""
                  srcDoc={m.body.html}
                  className="h-[440px] w-full rounded-xl border border-line-soft bg-white"
                />
              ) : (
                <div className="overflow-hidden rounded-xl border border-line-soft">
                  <Suspense
                    fallback={
                      <div className="flex h-[440px] items-center justify-center bg-card text-xs text-ink-soft">
                        Loading…
                      </div>
                    }
                  >
                    <CodeEditor
                      value={
                        view === 'text'
                          ? (m.body.text ?? '(no text part)')
                          : (m.body.html ?? '(no html part)')
                      }
                      lang={view === 'text' ? 'text' : 'html'}
                      readOnly
                      height="440px"
                    />
                  </Suspense>
                </div>
              )
            ) : (
              <p className="py-8 text-center text-sm text-ink-soft">
                Body not retained for this message.
              </p>
            )}
            {m.error_code && (
              <p className="mt-3 rounded-xl bg-bad-soft px-3 py-2 font-mono text-xs text-bad">
                {m.error_code}: {m.error_message}
              </p>
            )}
          </Card>

          <Card title="Recipients">
            <Table head={['Address', 'Kind', 'Status', 'Detail']}>
              {m.recipients.map(r => (
                <tr key={`${r.kind}-${r.address}`}>
                  <td className="px-4 py-2.5 font-medium">{r.address}</td>
                  <td className="px-4 py-2.5 font-mono text-[10.5px] uppercase text-ink-soft">
                    {r.kind}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge status={r.status} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-soft">
                    {r.error ?? latestMetaFor(r.address) ?? '-'}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>

        {/* inspector rail */}
        <div className="space-y-4 lg:sticky lg:top-6">
          <Card title="Timeline">
            <ol className="relative">
              {events.map((e, i) => (
                <li key={i} className="relative flex gap-2.5 pb-3.5 last:pb-0">
                  {i < events.length - 1 && (
                    <span className="absolute bottom-0 left-[4.5px] top-3.5 w-px bg-line-soft" />
                  )}
                  <span
                    className={`relative z-10 mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-card ${EVENT_TONE[e.event] ?? 'bg-line'}`}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold capitalize text-ink">
                      {e.event.replaceAll('_', ' ')}
                    </p>
                    {metaLine(e.meta_json) && (
                      <p className="break-words font-mono text-[10.5px] leading-relaxed text-ink-soft">
                        {metaLine(e.meta_json)}
                      </p>
                    )}
                    <p className="text-[10.5px] text-ink-soft/80">{fmtTime(e.created_at)}</p>
                  </div>
                </li>
              ))}
              {events.length === 0 && (
                <p className="text-xs text-ink-soft">No events recorded yet.</p>
              )}
            </ol>
          </Card>

          <Card title="Envelope">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5">
              <Kv label="From">
                {m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email}
              </Kv>
              <Kv label="To">{(JSON.parse(m.to_json) as string[]).join(', ')}</Kv>
              {m.cc_json && <Kv label="Cc">{(JSON.parse(m.cc_json) as string[]).join(', ')}</Kv>}
              {m.reply_to && <Kv label="Reply-To">{m.reply_to}</Kv>}
              <Kv label="Subject">{m.subject}</Kv>
            </dl>
          </Card>

          <Card title="Details">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5">
              <Kv label="Template">{m.template_id ?? '-'}</Kv>
              {m.provider_message_id && (
                <Kv label="Provider id">
                  <span className="font-mono text-[11px]">{m.provider_message_id}</span>
                </Kv>
              )}
              <Kv label="Attempts">{String(m.attempts)}</Kv>
              <Kv label="Created">{fmtTime(m.created_at)}</Kv>
              {m.sent_at && <Kv label="Sent">{fmtTime(m.sent_at)}</Kv>}
              {m.completed_at && <Kv label="Completed">{fmtTime(m.completed_at)}</Kv>}
            </dl>
          </Card>

          {m.body?.attachments && m.body.attachments.length > 0 && (
            <Card title="Attachments">
              <div className="space-y-2">
                {m.body.attachments.map((a, i) => (
                  <a
                    key={i}
                    href={`/api/messages/${m.id}/attachments/${i}`}
                    download={a.filename}
                    className="flex items-center gap-2.5 rounded-[10px] border border-line-soft bg-paper px-3 py-2 text-xs transition hover:border-accent/40"
                  >
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-soft" />
                    <span className="min-w-0 flex-1 truncate font-semibold text-accent-deep">
                      {a.filename}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-ink-soft">
                      {fmtSize(a.size)}
                      {a.disposition === 'inline' ? ' · inline' : ''}
                    </span>
                  </a>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
