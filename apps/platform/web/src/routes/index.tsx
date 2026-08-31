import type { ReactElement } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, Card, Empty, PageHeader } from '@/lib/ui';

export const Route = createFileRoute('/')({
  component: Overview,
});

interface OverviewData {
  sentToday: number;
  rejectedToday: number;
  last7d: number;
  byStatus: Record<string, number>;
  suppressions: number;
  activeDomains: number;
  quotaDailyLimit: number | null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): ReactElement {
  return (
    <div className="rounded-2xl border border-line-soft bg-card p-5 shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">{label}</p>
      <p className="mt-2 text-[28px] font-semibold leading-none tracking-tight tabular-nums">
        {value}
      </p>
      {hint && <p className="mt-2 text-xs text-ink-soft">{hint}</p>}
    </div>
  );
}

function Overview(): ReactElement {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.get<OverviewData>('/api/overview'),
    refetchInterval: 30_000,
  });
  const d = overview.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Overview" sub="What this instance sent, and where it stands." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Sent today"
          value={String(d?.sentToday ?? '-')}
          hint={
            d?.quotaDailyLimit
              ? `discovered daily cap: ${d.quotaDailyLimit}`
              : 'daily cap not yet discovered'
          }
        />
        <Stat label="Last 7 days" value={String(d?.last7d ?? '-')} />
        <Stat label="Active domains" value={String(d?.activeDomains ?? '-')} />
        <Stat label="Suppressions" value={String(d?.suppressions ?? '-')} />
      </div>
      {d?.quotaDailyLimit != null && d.sentToday >= d.quotaDailyLimit && (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm leading-relaxed text-warn">
          Today's discovered sending cap is reached - queued emails resume automatically after
          midnight UTC. Cloudflare raises the cap as your sender reputation grows; you can also
          request an increase from the Cloudflare dashboard.
        </p>
      )}
      <Card title="Last 7 days by status">
        {d && Object.keys(d.byStatus).length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {Object.entries(d.byStatus).map(([status, n]) => (
              <Link
                key={status}
                to="/emails"
                search={{ status }}
                className="flex items-center gap-2.5 rounded-xl border border-line-soft bg-card px-3.5 py-2 transition hover:border-accent/40 hover:shadow-[0_2px_8px_-2px_rgba(30,25,18,0.1)]"
              >
                <Badge status={status} />
                <span className="font-mono text-sm tabular-nums">{n}</span>
              </Link>
            ))}
          </div>
        ) : (
          <Empty>
            No emails sent yet.{' '}
            <Link to="/keys" className="text-accent underline">
              Create an API key
            </Link>{' '}
            - the Keys page has copy-paste send snippets.
          </Empty>
        )}
      </Card>
    </div>
  );
}
