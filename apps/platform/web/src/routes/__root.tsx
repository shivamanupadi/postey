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
      className="mx-3 mb-2.5 block rounded-[10px] bg-accent/18 px-3 py-2 text-xs font-semibold text-[#ff8fa3] transition hover:bg-accent/28 hover:text-[#ffb3c0]"
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
      <div className="flex min-h-screen items-center justify-center gap-2.5 text-sm text-ink-soft">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent motion-reduce:animate-none" />
        Loading…
      </div>
    );
  }
  if (me.isError) return <Navigate to="/login" />;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-[218px] shrink-0 flex-col bg-ink-deep text-cream">
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <img src="/logo-dark.svg" alt="" className="h-6 w-6" />
          <span className="text-[16.5px] font-semibold tracking-tight">
            postey<span className="text-accent">.</span>
          </span>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pt-1">
          {NAV.map(item => {
            const active = item.to === '/' ? path === '/' : path.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13.5px] font-medium transition ${
                  active ? 'bg-white/9 text-cream' : 'text-cream/60 hover:bg-white/5 hover:text-cream'
                }`}
              >
                <item.icon className={`h-4 w-4 ${active ? 'text-accent' : ''}`} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <UpdatePill />
        <div className="border-t border-white/10 px-5 py-4">
          <p className="truncate text-xs text-cream/50">{me.data?.email}</p>
          <button
            className="mt-2 flex items-center gap-1.5 text-xs font-medium text-cream/60 transition hover:text-cream"
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
      <main className="min-w-0 flex-1 px-10 py-9">
        <Outlet />
      </main>
    </div>
  );
}
