import type { ReactElement } from 'react';
import { createRootRoute, Link, Outlet, useRouterState, Navigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Gauge,
  Globe,
  Inbox,
  KeyRound,
  LayoutTemplate,
  Settings,
  ShieldOff,
  Sparkles,
  UserRound,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';

export const Route = createRootRoute({
  component: RootLayout,
});

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Key into the overview payload for the little count badge. */
  countKey?: 'last7d' | 'suppressions';
}

const SECTIONS: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [
      { to: '/', label: 'Overview', icon: Gauge },
      { to: '/emails', label: 'Emails', icon: Inbox, countKey: 'last7d' },
    ],
  },
  {
    label: 'Send',
    items: [
      { to: '/domains', label: 'Domains', icon: Globe },
      { to: '/keys', label: 'API keys', icon: KeyRound },
      { to: '/templates', label: 'Templates', icon: LayoutTemplate },
    ],
  },
  {
    label: 'Deliverability',
    items: [
      { to: '/suppressions', label: 'Suppressions', icon: ShieldOff, countKey: 'suppressions' },
      { to: '/webhooks', label: 'Webhooks', icon: Webhook },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

interface InstanceConfig {
  version: string | null;
  deployInstanceId: string | null;
}

function UpdatePill(): ReactElement | null {
  const config = useQuery({
    queryKey: ['instance-config'],
    queryFn: async () => {
      const res = await fetch('/api/config');
      return (await res.json()) as InstanceConfig;
    },
    staleTime: Infinity,
  });
  const latest = useQuery({
    queryKey: ['latest-version'],
    queryFn: async () => {
      const res = await fetch('https://postey.app/api/deploy/latest-version');
      const data = (await res.json()) as { data?: { version?: string } };
      return data.data?.version ?? null;
    },
    staleTime: 30 * 60_000,
    retry: false,
  });
  const current = config.data?.version;
  const instanceId = config.data?.deployInstanceId;
  if (!current || !instanceId || !latest.data || latest.data === current) return null;
  // Flat link row on the sidebar's own background - nav-item shaped, hover tint only.
  return (
    <a
      href={`https://postey.app/update?instance=${encodeURIComponent(instanceId)}`}
      target="_blank"
      rel="noreferrer"
      className="mx-3 mb-1.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold text-accent-deep transition hover:bg-card/55"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
      v{latest.data} available
      <span className="ml-auto font-medium">Update →</span>
    </a>
  );
}

function RootLayout(): ReactElement {
  const path = useRouterState({ select: s => s.location.pathname });
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ email: string }>('/api/me'),
    retry: false,
  });
  // Shares the overview cache with the Overview page; feeds the count badges.
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.get<{ last7d: number; suppressions: number }>('/api/overview'),
    staleTime: 60_000,
    retry: false,
  });

  if (path === '/login') return <Outlet />;
  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2.5 text-sm text-ink-soft">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent motion-reduce:animate-none" />
        Loading…
      </div>
    );
  }
  if (me.isError) return <Navigate to="/login" />;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-[220px] shrink-0 flex-col border-r border-[#ded5c6] bg-paper-deep">
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <img src="/logo.svg" alt="" className="h-6 w-6" />
          <span className="text-[16.5px] font-semibold tracking-tight text-ink">
            postey<span className="text-accent">.</span>
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto px-3">
          {SECTIONS.map((section, si) => (
            <div key={section.label ?? si}>
              {section.label && (
                <div className="px-2.5 pb-1.5 pt-4 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink-soft/70">
                  {section.label}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map(item => {
                  const active = item.to === '/' ? path === '/' : path.startsWith(item.to);
                  const count = item.countKey ? overview.data?.[item.countKey] : undefined;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] transition ${
                        active
                          ? 'bg-paper-deeper font-semibold text-ink before:absolute before:-left-3 before:bottom-[7px] before:top-[7px] before:w-[3px] before:rounded-r-[3px] before:bg-accent'
                          : 'font-medium text-ink-soft hover:bg-card/55 hover:text-ink'
                      }`}
                    >
                      <item.icon
                        className={`h-4 w-4 ${active ? 'text-ink' : 'text-ink-soft/70'}`}
                      />
                      {item.label}
                      {count !== undefined && count > 0 && (
                        <span className="ml-auto font-mono text-[10.5px] font-semibold text-ink-soft/70 tabular-nums">
                          {count > 999 ? '1k+' : count}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <UpdatePill />
        <div className="flex items-center gap-2.5 border-t border-[#ded5c6] px-4 py-3.5">
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-ink-deep text-cream">
            <UserRound className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11.5px] text-ink-soft">{me.data?.email}</p>
            <button
              className="text-[10.5px] font-medium text-ink-soft/70 transition hover:text-ink"
              onClick={async () => {
                await api.post('/api/auth/logout');
                queryClient.clear();
                window.location.href = '/login';
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-10 py-9">
        <Outlet />
      </main>
    </div>
  );
}
