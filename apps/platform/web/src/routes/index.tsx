import type { ReactElement } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, Card, Empty, PageHeader } from '@/lib/ui';

export const Route = createFileRoute('/')({
  component: Overview,
});

interface AttentionRow {
  id: string;
  to_json: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
}

interface OverviewData {
  sentToday: number;
  rejectedToday: number;
  last7d: number;
  byStatus: Record<string, number>;
  suppressions: number;
  activeDomains: number;
  daily: { day: string; n: number }[];
  queuedNow: number;
  lastSendAt: number | null;
  attention: AttentionRow[];
  suppressed7d: number;
}

interface RecentRow {
  id: string;
  to_json: string;
  subject: string;
  status: string;
  created_at: number;
}

const ago = (ms: number): string => {
  const delta = Date.now() - ms;
  if (!Number.isFinite(delta) || delta < 0) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const firstTo = (toJson: string): string => {
  try {
    return (JSON.parse(toJson) as string[])[0] ?? '?';
  } catch {
    return '?';
  }
};

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

/* ── daily sends bar chart ─────────────────────────────────────────
 * 14 UTC days, bars with 4px rounded tops anchored to the baseline,
 * faint gridlines, native tooltips, sparse weekday labels. */

const CHART_GREEN = '#1a7f4e';
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function topRoundRect(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} v${-(h - rr)} q0,${-rr} ${rr},${-rr} h${w - 2 * rr} q${rr},0 ${rr},${rr} v${h - rr} z`;
}

function DailyChart({ daily }: { daily: { day: string; n: number }[] }): ReactElement {
  const byDay = new Map(daily.map(d => [d.day, d.n]));
  const days: { key: string; label: string; n: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, label: WEEKDAY[d.getUTCDay()], n: byDay.get(key) ?? 0 });
  }
  const maxN = Math.max(...days.map(d => d.n));
  // Round the axis top to a friendly 3-step scale.
  const step = Math.max(1, Math.ceil(Math.max(maxN, 1) / 3));
  const top = step * 3;

  const W = 760;
  const H = 190;
  const padL = 34;
  const padB = 20;
  const padT = 14;
  const plotW = W - padL - 8;
  const plotH = H - padT - padB;
  const bw = Math.min(30, (plotW - 13 * 8) / 14);
  const gap = (plotW - 14 * bw) / 13;
  const y = (v: number): number => padT + plotH * (1 - v / top);
  const hOf = (v: number): number => plotH * (v / top);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Emails per day, last 14 days"
      className="block h-auto w-full"
    >
      {[0, step, step * 2, top].map(g => (
        <g key={g}>
          <line x1={padL} x2={W - 8} y1={y(g)} y2={y(g)} stroke="#ece4d6" strokeWidth={1} />
          <text x={padL - 6} y={y(g) + 3} textAnchor="end" fontSize={10} fill="#8a867f">
            {g}
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        const x = padL + i * (bw + gap);
        return (
          <g key={d.key} className="transition-opacity hover:opacity-80">
            <title>{`${d.key} · ${d.n} sent`}</title>
            {/* full-height hit target so hover works on short bars */}
            <rect x={x} y={padT} width={bw} height={plotH} fill="transparent" />
            <path d={topRoundRect(x, y(d.n), bw, hOf(d.n), 4)} fill={CHART_GREEN} />
            <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#8a867f">
              {d.label}
            </text>
            {d.n === maxN && d.n > 0 && (
              <text
                x={x + bw / 2}
                y={y(d.n) - 5}
                textAnchor="middle"
                fontSize={10}
                fontWeight={600}
                fill="#57534e"
              >
                {d.n}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* --------------------------------- page ---------------------------------- */

function Overview(): ReactElement {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.get<OverviewData>('/api/overview'),
    refetchInterval: 30_000,
  });
  const recent = useQuery({
    queryKey: ['recent-messages'],
    queryFn: () => api.get<RecentRow[]>('/api/messages?limit=5'),
    refetchInterval: 30_000,
  });
  const d = overview.data;

  const delivered = d?.byStatus.delivered ?? 0;
  const hardBounces = (d?.byStatus.bounced ?? 0) + (d?.byStatus.complained ?? 0);
  const deliveredRate = d && d.last7d > 0 ? (delivered / d.last7d) * 100 : null;
  const bounceRate = d && d.last7d > 0 ? (hardBounces / d.last7d) * 100 : null;
  const fmtRate = (r: number | null): string =>
    r === null ? '-' : `${r.toFixed(r >= 10 ? 0 : 1)}%`;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Overview"
        sub="What this instance sent, and where it stands."
        action={
          <span className="rounded-lg border border-line-soft bg-card px-3 py-1.5 text-[12.5px] font-medium text-ink-soft">
            Last 14 days
          </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Sent today"
          value={String(d?.sentToday ?? '-')}
          hint={d?.lastSendAt ? `last send ${ago(d.lastSendAt)}` : 'no sends yet'}
        />
        <Stat
          label="Delivered · 7d"
          value={fmtRate(deliveredRate)}
          hint={d && d.last7d > 0 ? `${delivered} of ${d.last7d} sends` : 'no sends this week'}
        />
        <Stat
          label="Bounce rate · 7d"
          value={fmtRate(bounceRate)}
          hint={
            hardBounces > 0
              ? `${hardBounces} hard bounce${hardBounces > 1 ? 's' : ''}, auto-suppressed`
              : 'no hard bounces'
          }
        />
        <Stat
          label="Queued now"
          value={String(d?.queuedNow ?? '-')}
          hint={d && d.queuedNow > 0 ? 'sending shortly' : 'nothing waiting'}
        />
      </div>

      <Card title="Emails per day" sub="All sends, last 14 days">
        {d && d.daily.length > 0 ? (
          <DailyChart daily={d.daily} />
        ) : (
          <Empty>
            {overview.isLoading ? (
              'Loading…'
            ) : (
              <>
                No sends in the last 14 days.{' '}
                <Link to="/keys" className="text-accent underline">
                  Create an API key
                </Link>{' '}
                - the Keys page has copy-paste send snippets.
              </>
            )}
          </Empty>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        <Card
          title="Recent sends"
          action={
            <Link to="/emails" className="text-[12.5px] font-medium text-accent hover:underline">
              Open the email log →
            </Link>
          }
        >
          {recent.data?.length ? (
            <table className="w-full text-left text-[13px]">
              <tbody className="divide-y divide-[#efe8dc]">
                {recent.data.map(m => (
                  <tr key={m.id}>
                    <td className="py-2.5 pr-3">
                      <Link
                        to="/emails/$id"
                        params={{ id: m.id }}
                        className="font-medium hover:text-accent"
                      >
                        {m.subject}
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-soft">{firstTo(m.to_json)}</p>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge status={m.status} />
                    </td>
                    <td className="whitespace-nowrap py-2.5 text-right text-xs text-ink-soft tabular-nums">
                      {ago(m.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-6 text-center text-sm text-ink-soft">
              {recent.isLoading ? 'Loading…' : 'No emails sent yet.'}
            </p>
          )}
        </Card>

        <Card title="Needs attention" sub="Bounces and failures from the last 7 days">
          {d?.attention.length ? (
            <div className="space-y-2">
              {d.attention.map(a => (
                <Link
                  key={a.id}
                  to="/emails/$id"
                  params={{ id: a.id }}
                  className="block rounded-[10px] bg-paper px-3 py-2.5 transition hover:bg-paper-deep/60"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12.5px] font-semibold">
                      {firstTo(a.to_json)}
                    </span>
                    <Badge status={a.status} />
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-ink-soft">
                    {a.error_code
                      ? `${a.error_code}${a.error_message ? ` · ${a.error_message}` : ''}`
                      : (a.error_message ?? ago(a.created_at))}
                  </p>
                </Link>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-ink-soft">
              {overview.isLoading ? 'Loading…' : 'Nothing needs attention.'}
            </p>
          )}
          {d && d.suppressed7d > 0 && (
            <p className="mt-3 text-xs text-ink-soft">
              {d.suppressed7d} address{d.suppressed7d > 1 ? 'es' : ''} auto-suppressed this week ·{' '}
              <Link to="/suppressions" className="font-medium text-accent hover:underline">
                review suppressions →
              </Link>
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
