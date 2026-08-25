import type { ReactElement } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, Card, Empty } from '@/lib/ui';

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
    <div className="rounded-2xl border border-line bg-white/60 p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{label}</p>
      <p className="mt-2 font-display text-3xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-soft">{hint}</p>}
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
      <h1 className="font-display text-2xl font-semibold">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Sent today"
          value={String(d?.sentToday ?? '—')}
          hint={
            d?.quotaDailyLimit
              ? `discovered daily cap: ${d.quotaDailyLimit}`
              : 'daily cap not yet discovered'
          }
        />
        <Stat label="Last 7 days" value={String(d?.last7d ?? '—')} />
        <Stat label="Active domains" value={String(d?.activeDomains ?? '—')} />
        <Stat label="Suppressions" value={String(d?.suppressions ?? '—')} />
      </div>
      {d?.quotaDailyLimit != null && d.sentToday >= d.quotaDailyLimit && (
        <p className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent-deep">
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
                className="flex items-center gap-2 rounded-xl border border-line px-3.5 py-2 hover:border-accent/50"
              >
                <Badge status={status} />
                <span className="font-mono text-sm">{n}</span>
              </Link>
            ))}
          </div>
        ) : (
          <Empty>No emails sent yet. Create an API key and send your first one.</Empty>
        )}
      </Card>
    </div>
  );
}
