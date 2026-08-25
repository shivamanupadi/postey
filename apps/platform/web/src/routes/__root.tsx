import type { ReactElement } from 'react';
import { createRootRoute, Link, Outlet, useRouterState, Navigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Gauge,
  Globe,
  Inbox,
  KeyRound,
  LayoutTemplate,
  LogOut,
  Settings,
  ShieldOff,
  Webhook,
} from 'lucide-react';
import { api } from '@/lib/api';

export const Route = createRootRoute({
  component: RootLayout,
});

const NAV = [
  { to: '/', label: 'Overview', icon: Gauge },
  { to: '/emails', label: 'Emails', icon: Inbox },
  { to: '/domains', label: 'Domains', icon: Globe },
  { to: '/keys', label: 'API keys', icon: KeyRound },
  { to: '/templates', label: 'Templates', icon: LayoutTemplate },
  { to: '/suppressions', label: 'Suppressions', icon: ShieldOff },
  { to: '/webhooks', label: 'Webhooks', icon: Webhook },
  { to: '/settings', label: 'Settings', icon: Settings },
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
  return (
    <a
      href={`https://postey.app/update?instance=${encodeURIComponent(instanceId)}`}
      target="_blank"
      rel="noreferrer"
      className="mx-3 mb-2 block rounded-xl bg-accent/15 px-3 py-2 text-xs font-semibold text-accent transition hover:bg-accent/25"
    >
      Update available: v{latest.data} →
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

  if (path === '/login') return <Outlet />;
  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-ink-soft">
        Loading…
      </div>
    );
  }
  if (me.isError) return <Navigate to="/login" />;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-white/10 bg-ink text-cream">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <img src="/logo-dark.svg" alt="" className="h-7 w-7" />
          <span className="font-display text-xl font-semibold">
            postey<span className="text-accent">.</span>
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map(item => {
            const active = item.to === '/' ? path === '/' : path.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition ${
                  active ? 'bg-white/10 text-cream' : 'text-cream/60 hover:text-cream'
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <UpdatePill />
        <div className="border-t border-white/10 px-5 py-4">
          <p className="truncate text-xs text-cream/50">{me.data?.email}</p>
          <button
            className="mt-2 flex items-center gap-1.5 text-xs font-medium text-cream/60 hover:text-cream"
            onClick={async () => {
              await api.post('/api/auth/logout');
              queryClient.clear();
              window.location.href = '/login';
            }}
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}
