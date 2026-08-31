import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import { Badge, Dropdown, Empty, PageHeader, Table } from '@/lib/ui';

export const Route = createFileRoute('/emails/')({
  component: EmailsPage,
  validateSearch: (s: Record<string, unknown>): { status?: string } =>
    typeof s.status === 'string' ? { status: s.status } : {},
});

interface MessageRow {
  id: string;
  from_email: string;
  from_name: string | null;
  to_json: string;
  subject: string;
  status: string;
  error_code: string | null;
  template_id: string | null;
  created_at: number;
  recipient_count: number;
}

interface MessagePage {
  data: MessageRow[];
  nextBefore: number | null;
}

type DateKey = 'today' | '7d' | '30d' | 'all';

const DATE_OPTIONS: { value: DateKey; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

/** Rounded to 5 minutes so react-query keys stay stable across renders. */
function afterOf(key: DateKey): number {
  const now = Math.floor(Date.now() / 300_000) * 300_000;
  if (key === 'today') return new Date().setHours(0, 0, 0, 0);
  if (key === '7d') return now - 7 * 86_400_000;
  if (key === '30d') return now - 30 * 86_400_000;
  return 0;
}

/** Chip order mirrors the delivery lifecycle. */
const STATUS_ORDER = [
  'delivered',
  'sent',
  'queued',
  'scheduled',
  'sending',
  'deferred',
  'partial',
  'bounced',
  'complained',
  'rejected',
  'failed',
  'suppressed',
];

const PAGE_SIZE = 50;

/** Raw fetch that keeps the cursor - api.get unwraps `.data` and would lose it. */
async function fetchMessages(params: URLSearchParams): Promise<MessagePage> {
  const res = await fetch(`/api/messages?${params}`, { credentials: 'same-origin' });
  const body = (await res.json().catch(() => null)) as MessagePage | null;
  if (!res.ok || !body) throw new Error('failed to load messages');
  return body;
}

function EmailsPage(): ReactElement {
  const { status: statusFromUrl } = Route.useSearch();
  const navigate = Route.useNavigate();
  const status = statusFromUrl ?? '';

  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [dateKey, setDateKey] = useState<DateKey>('30d');
  const [domainId, setDomainId] = useState('');
  const [templateId, setTemplateId] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 350);
    return () => window.clearTimeout(t);
  }, [q]);

  const after = afterOf(dateKey);
  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (after > 0) p.set('after', String(after));
    if (domainId) p.set('domain_id', domainId);
    if (templateId) p.set('template_id', templateId);
    if (qDebounced) p.set('q', qDebounced);
    return p;
  }, [after, domainId, templateId, qDebounced]);

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/api/domains'),
  });
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<{ id: string; slug: string; version: number }[]>('/api/templates'),
  });
  const counts = useQuery({
    queryKey: ['msg-counts', filterParams.toString()],
    queryFn: () => api.get<Record<string, number>>(`/api/messages/status-counts?${filterParams}`),
    refetchInterval: 30_000,
  });

  const messages = useInfiniteQuery({
    queryKey: ['messages', filterParams.toString(), status],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(filterParams);
      p.set('limit', String(PAGE_SIZE));
      if (status) p.set('status', status);
      if (pageParam) p.set('before', String(pageParam));
      return fetchMessages(p);
    },
    initialPageParam: 0,
    getNextPageParam: last => last.nextBefore,
    refetchInterval: 15_000,
  });

  const rows = messages.data?.pages.flatMap(p => p.data) ?? [];
  const total = Object.values(counts.data ?? {}).reduce((a, b) => a + b, 0);
  const chipStatuses = STATUS_ORDER.filter(s => (counts.data?.[s] ?? 0) > 0);
  const templateSlug = (id: string | null): string | null =>
    id ? (templates.data?.find(t => t.id === id)?.slug ?? null) : null;
  const setStatus = (s: string): void =>
    void navigate({ search: s ? { status: s } : {}, replace: true });

  const filtersActive = Boolean(q || domainId || templateId || status || dateKey !== '30d');
  const resetFilters = (): void => {
    setQ('');
    setQDebounced('');
    setDateKey('30d');
    setDomainId('');
    setTemplateId('');
    setStatus('');
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Emails" sub="Every send with its status and delivery timeline." />

      {/* filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft/60" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search subject, recipient, or sender…"
            className="w-full rounded-[10px] border border-line bg-card py-2 pl-9 pr-3.5 text-sm text-ink outline-none transition placeholder:text-ink-soft/45 focus:border-accent focus:ring-2 focus:ring-accent/15"
          />
        </div>
        <Dropdown value={dateKey} options={DATE_OPTIONS} onChange={setDateKey} />
        <Dropdown
          label="Domain"
          value={domainId}
          onChange={setDomainId}
          options={[
            { value: '', label: 'All' },
            ...(domains.data ?? []).map(d => ({ value: d.id, label: d.name })),
          ]}
        />
        <Dropdown
          label="Template"
          value={templateId}
          onChange={setTemplateId}
          options={[
            { value: '', label: 'All' },
            ...(templates.data ?? []).map(t => ({ value: t.id, label: t.slug })),
          ]}
        />
      </div>

      {/* status chips */}
      <div className="flex flex-wrap items-center gap-1">
        <StatusChip label="All" count={total} active={status === ''} onClick={() => setStatus('')} />
        {chipStatuses.map(s => (
          <StatusChip
            key={s}
            label={s}
            count={counts.data?.[s] ?? 0}
            active={status === s}
            onClick={() => setStatus(s)}
          />
        ))}
        {filtersActive && (
          <button
            type="button"
            onClick={resetFilters}
            className="ml-auto rounded-full px-3 py-1 text-xs font-medium text-accent transition hover:bg-accent-soft"
          >
            Reset filters
          </button>
        )}
      </div>

      {rows.length > 0 ? (
        <Table
          head={['Recipient', 'Subject', 'Template', 'Status', 'Sent']}
          foot={
            <>
              <span className="tabular-nums">
                Showing {rows.length}
                {status ? ` ${status}` : ''}
              </span>
              {messages.hasNextPage ? (
                <button
                  type="button"
                  onClick={() => void messages.fetchNextPage()}
                  disabled={messages.isFetchingNextPage}
                  className="rounded-lg border border-line bg-card px-4 py-1.5 text-xs font-medium text-ink-soft transition hover:bg-paper hover:text-ink disabled:opacity-50"
                >
                  {messages.isFetchingNextPage ? 'Loading…' : `Load ${PAGE_SIZE} more`}
                </button>
              ) : (
                <span>end of results</span>
              )}
              <span>newest first</span>
            </>
          }
        >
          {rows.map(m => (
            <tr key={m.id} className="transition hover:bg-paper/60">
              <td className="px-4 py-2.5">
                <Link
                  to="/emails/$id"
                  params={{ id: m.id }}
                  className="font-medium hover:text-accent"
                >
                  {(JSON.parse(m.to_json) as string[])[0]}
                  {m.recipient_count > 1 ? ` +${m.recipient_count - 1}` : ''}
                </Link>
                <p className="mt-0.5 font-mono text-[10.5px] text-ink-soft/80">{m.id}</p>
              </td>
              <td className="max-w-[260px] truncate px-4 py-2.5 text-ink-soft">{m.subject}</td>
              <td className="px-4 py-2.5">
                {templateSlug(m.template_id) ? (
                  <span className="rounded-md border border-line-soft bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-ink-soft">
                    {templateSlug(m.template_id)}
                  </span>
                ) : (
                  <span className="text-xs text-ink-soft/50">-</span>
                )}
              </td>
              <td className="px-4 py-2.5">
                <Badge status={m.status} />
                {m.error_code && (
                  <p className="mt-1 font-mono text-[10.5px] text-bad">{m.error_code}</p>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-soft">
                {fmtTime(m.created_at)}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>
          {messages.isLoading
            ? 'Loading…'
            : total === 0 && !qDebounced && !status
              ? 'No emails in this window yet.'
              : 'No emails match these filters.'}
        </Empty>
      )}
    </div>
  );
}

function StatusChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
        active ? 'bg-paper-deeper font-semibold text-ink' : 'text-ink-soft hover:text-ink'
      }`}
    >
      {label}
      <span className={`font-mono text-[10px] tabular-nums ${active ? 'text-ink-soft' : 'text-ink-soft/60'}`}>
        {count}
      </span>
    </button>
  );
}
