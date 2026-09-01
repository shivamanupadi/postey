import { useState, type ReactElement } from 'react';
import { createRootRoute, Link, Outlet, useRouterState, Navigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronsUpDown,
  Gauge,
  Globe,
  Inbox,
  KeyRound,
  LayoutTemplate,
  Plug,
  Plus,
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
      { to: '/mcp', label: 'MCP server', icon: Plug },
    ],
  },
  {
    label: 'Deliverability',
    items: [
      { to: '/suppressions', label: 'Suppressions', icon: ShieldOff, countKey: 'suppressions' },
      { to: '/webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
];

interface InstanceConfig {
  version: string | null;
  deployInstanceId: string | null;
}

export interface InboxAddressRow {
  id: string;
  local_part: string;
  domain_id: string;
  domain_name: string;
  message_count: number;
  unread_count: number;
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
      className="mx-3 mb-1.5 flex items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs font-semibold text-accent-deep transition hover:bg-card/55"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
      <span className="min-w-0 truncate">Update to v{latest.data}</span>
      <span className="ml-auto shrink-0 font-medium">→</span>
    </a>
  );
}

/* ── product switcher ────────────────────────────────────────────── */

type Product = 'send' | 'inbox';

const PRODUCT_META: Record<
  Product,
  { name: string; tagline: string; home: string; chip: string }
> = {
  send: { name: 'Send', tagline: 'Transactional email API', home: '/', chip: 'bg-[#ff4d6d]' },
  inbox: { name: 'Inbox', tagline: 'Replies & inbound mail', home: '/inbox', chip: 'bg-[#3f5bd9]' },
};

function ProductSwitcher({
  product,
  inboxUnread,
}: {
  product: Product;
  inboxUnread: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const meta = PRODUCT_META[product];
  return (
    <div className="relative px-3 pb-2 pt-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition ${
          open ? 'border-line-soft bg-card' : 'border-transparent hover:border-line-soft hover:bg-card/70'
        }`}
      >
        <img src="/logo.svg" alt="" className="h-6 w-6" />
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold leading-tight tracking-tight text-ink">
            postey<span className="text-accent">.</span>
          </span>
          <span className="block text-[9.5px] font-bold uppercase tracking-[0.14em] text-accent-deep">
            {meta.name}
          </span>
        </span>
        <ChevronsUpDown className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-soft/70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-3 right-3 z-50 mt-1.5 rounded-xl border border-line-soft bg-card p-1.5 shadow-[0_20px_44px_-16px_rgba(30,25,18,0.3)]">
            {(Object.keys(PRODUCT_META) as Product[]).map(p => {
              const m = PRODUCT_META[p];
              const active = p === product;
              return (
                <Link
                  key={p}
                  to={m.home}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition ${
                    active ? 'bg-paper' : 'hover:bg-paper/70'
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white ${m.chip}`}
                  >
                    <Inbox className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-ink">{m.name}</span>
                    <span className="block text-[10.5px] leading-tight text-ink-soft">
                      {m.tagline}
                    </span>
                  </span>
                  {active ? (
                    <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-ok" />
                  ) : p === 'inbox' && inboxUnread > 0 ? (
                    <span className="ml-auto shrink-0 rounded-full bg-[#e7ebfc] px-2 py-0.5 text-[10px] font-bold text-[#3f51c9]">
                      {inboxUnread > 99 ? '99+' : inboxUnread}
                    </span>
                  ) : null}
                </Link>
              );
            })}
            <p className="border-t border-line-soft px-2.5 pb-1 pt-2 text-[9.5px] text-ink-soft/80">
              One instance · one login · shared domains
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/* ── layout ──────────────────────────────────────────────────────── */

function RootLayout(): ReactElement {
  const path = useRouterState({ select: s => s.location.pathname });
  const search = useRouterState({ select: s => s.location.search as { addr?: string } });
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
  const addresses = useQuery({
    queryKey: ['inbox-addresses'],
    queryFn: () => api.get<InboxAddressRow[]>('/api/inbox/addresses'),
    staleTime: 30_000,
    retry: false,
  });

  const product: Product = path.startsWith('/inbox') ? 'inbox' : 'send';
  const inboxUnread =
    addresses.data?.reduce((sum, a) => sum + Number(a.unread_count || 0), 0) ?? 0;
  const byDomain = new Map<string, InboxAddressRow[]>();
  for (const a of addresses.data ?? []) {
    byDomain.set(a.domain_name, [...(byDomain.get(a.domain_name) ?? []), a]);
  }

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

  const navLink = (active: boolean): string =>
    `relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] transition ${
      active
        ? 'bg-paper-deeper font-semibold text-ink before:absolute before:-left-3 before:bottom-[7px] before:top-[7px] before:w-[3px] before:rounded-r-[3px] before:bg-accent'
        : 'font-medium text-ink-soft hover:bg-card/55 hover:text-ink'
    }`;

  return (
    <div className={`flex min-h-screen ${product === 'inbox' ? 'product-inbox' : ''}`}>
      <aside className="sticky top-0 flex h-screen w-[220px] shrink-0 flex-col border-r border-[#ded5c6] bg-paper-deep">
        <ProductSwitcher product={product} inboxUnread={inboxUnread} />
        <nav className="flex-1 overflow-y-auto px-3">
          {product === 'send' ? (
            SECTIONS.map((section, si) => (
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
                      <Link key={item.to} to={item.to} className={navLink(active)}>
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
            ))
          ) : (
            <>
              <div className="space-y-0.5 pt-1">
                <Link to="/inbox" className={navLink(!search.addr)}>
                  <Inbox className={`h-4 w-4 ${!search.addr ? 'text-ink' : 'text-ink-soft/70'}`} />
                  All mail
                  {inboxUnread > 0 && (
                    <span className="ml-auto rounded-full bg-accent-soft px-1.5 py-px font-mono text-[10px] font-bold text-accent-deep tabular-nums">
                      {inboxUnread}
                    </span>
                  )}
                </Link>
              </div>
              {[...byDomain.entries()].map(([domainName, rows]) => (
                <div key={domainName}>
                  <div className="truncate px-2.5 pb-1.5 pt-4 font-mono text-[10px] font-semibold tracking-tight text-ink-soft/70">
                    {domainName}
                  </div>
                  <div className="space-y-0.5">
                    {rows.map(a => {
                      const active = search.addr === a.id;
                      return (
                        <Link
                          key={a.id}
                          to="/inbox"
                          search={{ addr: a.id }}
                          className={navLink(active)}
                        >
                          <span className="truncate font-mono text-[12px]">{a.local_part}@</span>
                          {Number(a.unread_count) > 0 && (
                            <span className="ml-auto rounded-full bg-accent-soft px-1.5 py-px font-mono text-[10px] font-bold text-accent-deep tabular-nums">
                              {a.unread_count}
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="pt-4">
                <Link
                  to="/inbox"
                  search={{ new: true }}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-2 text-[12px] font-semibold text-ink-soft transition hover:border-accent/50 hover:text-accent-deep"
                >
                  <Plus className="h-3.5 w-3.5" /> New address
                </Link>
              </div>
            </>
          )}
        </nav>
        {product === 'send' && <UpdatePill />}
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
