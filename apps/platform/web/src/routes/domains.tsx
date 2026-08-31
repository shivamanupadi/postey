import { useState, type ReactElement, type FormEvent, type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  Empty,
  ErrorNote,
  Input,
  PageHeader,
  Table,
} from '@/lib/ui';

export const Route = createFileRoute('/domains')({
  component: DomainsPage,
});

interface DomainRow {
  id: string;
  name: string;
  status: string;
  default_from: string | null;
  onboarded_at: number | null;
  created_at: number;
  message_count: number;
  key_count: number;
  template_count: number;
  /** Live cf-bounce DNS check: true = onboarded in Cloudflare, false = not yet. */
  dns_ready: boolean | null;
}

function DnsLine({ d }: { d: DomainRow }): ReactElement {
  const dot = (color: string, label: string): ReactElement => (
    <span className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-soft">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
  if (d.status === 'archived') return dot('bg-line', 'sending disabled');
  if (d.status === 'active') return dot('bg-ok', 'DNS ready');
  if (d.dns_ready === true) return dot('bg-ok', 'DNS ready - activate now');
  if (d.dns_ready === false) return dot('bg-warn', 'awaiting Cloudflare onboarding');
  return dot('bg-line', 'checking DNS…');
}

function CheckRow({
  ok,
  label,
  detail,
}: {
  ok: boolean | null;
  label: string;
  detail?: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-[12.5px] text-ink">
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
          ok === null
            ? 'bg-paper text-ink-soft'
            : ok
              ? 'bg-ok-soft text-ok'
              : 'bg-warn-soft text-warn'
        }`}
      >
        {ok === null ? '·' : ok ? '✓' : '!'}
      </span>
      {label}
      <span className="ml-auto font-mono text-[10.5px] text-ink-soft">
        {detail ?? (ok === null ? 'checking…' : ok ? 'found' : 'not found yet')}
      </span>
    </div>
  );
}

function DrawerStat({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-soft">{label}</p>
      <p className="mt-0.5 break-words text-[13px] font-medium tabular-nums">{children}</p>
    </div>
  );
}

function DomainDrawer({ d, onClose }: { d: DomainRow; onClose: () => void }): ReactElement {
  const checks = useQuery({
    queryKey: ['domain-checks', d.id],
    queryFn: () => api.get<{ spf: boolean; dkim: boolean; mx: boolean }>(`/api/domains/${d.id}/checks`),
    staleTime: 30_000,
  });
  const c = checks.data;
  return (
    <Drawer
      title={d.name}
      sub={
        <span className="flex items-center gap-2">
          <Badge status={d.status} />
          <DnsLine d={d} />
        </span>
      }
      onClose={onClose}
    >
      <div className="space-y-5">
        <section>
          <h3 className="mb-1.5 text-[12.5px] font-semibold text-ink">Email Sending onboarding</h3>
          <div className="divide-y divide-[#efe8dc]">
            <CheckRow ok={true} label="Registered on this instance" detail={fmtTime(d.created_at)} />
            <CheckRow ok={c ? c.spf : null} label="cf-bounce TXT (SPF)" />
            <CheckRow ok={c ? c.dkim : null} label="cf-bounce._domainkey (DKIM)" />
            <CheckRow ok={c ? c.mx : null} label="cf-bounce MX" />
          </div>
          {c && !(c.spf || c.dkim || c.mx) && (
            <p className="mt-2 rounded-[10px] bg-warn-soft px-3 py-2.5 text-[11.5px] leading-relaxed text-warn">
              Onboard the domain in the{' '}
              <a
                className="font-semibold underline"
                href="https://dash.cloudflare.com/?to=/:account/email-service/sending"
                target="_blank"
                rel="noreferrer"
              >
                Cloudflare dashboard
              </a>{' '}
              (Email Service → Onboard Domain) - the records appear and lock automatically, then
              Verify &amp; activate flips it on.
            </p>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-[12.5px] font-semibold text-ink">Sending</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <DrawerStat label="Emails">{d.message_count}</DrawerStat>
            <DrawerStat label="API keys scoped">{d.key_count}</DrawerStat>
            <DrawerStat label="Templates scoped">{d.template_count}</DrawerStat>
            <DrawerStat label="Default from">
              <span className="font-mono text-[11.5px] font-normal">
                {d.default_from ?? '-'}
              </span>
            </DrawerStat>
            <DrawerStat label="Added">
              <span className="text-xs font-normal text-ink-soft">{fmtTime(d.created_at)}</span>
            </DrawerStat>
            <DrawerStat label="Onboarded">
              <span className="text-xs font-normal text-ink-soft">
                {d.onboarded_at ? fmtTime(d.onboarded_at) : '-'}
              </span>
            </DrawerStat>
          </div>
        </section>
      </div>
    </Drawer>
  );
}

function DomainsPage(): ReactElement {
  const qc = useQueryClient();
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<DomainRow[]>('/api/domains'),
  });
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<DomainRow | null>(null);
  const [archiving, setArchiving] = useState<DomainRow | null>(null);
  const [inspecting, setInspecting] = useState<DomainRow | null>(null);

  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['domains'] });
  const add = useMutation({
    mutationFn: () => api.post('/api/domains', { name }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const activate = useMutation({
    mutationFn: (id: string) => api.post(`/api/domains/${id}/activate`),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/api/domains/${id}/archive`),
    onSuccess: () => {
      setArchiving(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/domains/${id}`),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (name) add.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Domains"
        sub="Domains this instance may send from. Each needs Email Sending onboarding on Cloudflare's side."
      />
      <Card title="Add a sending domain">
        <form onSubmit={submit} className="flex gap-3">
          <Input placeholder="mail.example.com" value={name} onChange={e => setName(e.target.value)} />
          <Button type="submit" disabled={add.isPending}>
            Add domain
          </Button>
        </form>
        <p className="mt-3 text-xs leading-relaxed text-ink-soft">
          Registers the domain on this instance. Then onboard it to Email Sending in the{' '}
          <a
            className="font-medium text-accent hover:underline"
            href="https://dash.cloudflare.com/?to=/:account/email-service/sending"
            target="_blank"
            rel="noreferrer"
          >
            Cloudflare dashboard
          </a>{' '}
          and use Verify &amp; activate - the DNS check runs automatically.
        </p>
        <ErrorNote error={add.error ?? activate.error ?? archive.error ?? remove.error} />
      </Card>

      {domains.data?.length ? (
        <Table head={['Domain', 'Status', 'Emails', 'Added', '']}>
          {domains.data.map(d => (
            <tr key={d.id} className={d.status === 'archived' ? 'opacity-70' : ''}>
              <td className="px-4 py-3">
                <p className="text-[13px] font-semibold">{d.name}</p>
                <p className="mt-0.5 font-mono text-[10.5px] text-ink-soft">
                  {d.default_from ?? 'no default from'}
                </p>
              </td>
              <td className="px-4 py-3">
                <Badge status={d.status} />
                <DnsLine d={d} />
              </td>
              <td className="px-4 py-3 font-mono text-xs tabular-nums">{d.message_count}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">{fmtTime(d.created_at)}</td>
              <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setInspecting(d)}
                    aria-label={`Details for ${d.name}`}
                    className="rounded-lg p-1.5 text-ink-soft transition hover:bg-paper hover:text-ink"
                  >
                    <Info className="h-4 w-4" />
                  </button>
                  {(d.status === 'pending' || d.status === 'archived') && (
                    <Button variant="ghost" onClick={() => activate.mutate(d.id)}>
                      {d.status === 'archived' ? 'Unarchive' : 'Verify & activate'}
                    </Button>
                  )}
                  {d.status === 'active' && (
                    <Button variant="ghost" onClick={() => setArchiving(d)}>
                      Archive
                    </Button>
                  )}
                  {d.message_count === 0 ? (
                    <Button variant="danger" onClick={() => setDeleting(d)}>
                      Delete
                    </Button>
                  ) : (
                    d.status === 'archived' && (
                      <span className="self-center text-[10px] text-ink-soft">
                        history retained
                      </span>
                    )
                  )}
                </div>
                {d.message_count > 0 && d.status !== 'archived' && (
                  <p className="mt-1 text-[10px] text-ink-soft">
                    has send history - archive to stop sending
                  </p>
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{domains.isLoading ? 'Loading…' : 'No domains yet.'}</Empty>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          sub="This cannot be undone."
          confirmLabel="Delete domain"
          confirmWord={deleting.name}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        >
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            The domain is unregistered from this instance and sending from{' '}
            <code className="font-mono">@{deleting.name}</code> stops immediately.
          </p>
          {(deleting.key_count > 0 || deleting.template_count > 0) && (
            <ul className="mt-3 space-y-1 rounded-[10px] bg-bad-soft px-3.5 py-3 text-xs leading-relaxed text-[#7a1f16]">
              {deleting.key_count > 0 && (
                <li>
                  • {deleting.key_count} API key{deleting.key_count > 1 ? 's' : ''} scoped to this
                  domain will be revoked
                </li>
              )}
              {deleting.template_count > 0 && (
                <li>
                  • {deleting.template_count} scoped template
                  {deleting.template_count > 1 ? 's' : ''} become shared
                </li>
              )}
              <li>• Suppressions scoped to this domain are removed</li>
            </ul>
          )}
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-soft">
            Cloudflare's Email Sending onboarding and DNS records stay untouched - re-adding the
            domain later picks them right back up.
          </p>
        </ConfirmDialog>
      )}

      {inspecting && <DomainDrawer d={inspecting} onClose={() => setInspecting(null)} />}

      {archiving && (
        <ConfirmDialog
          title={`Archive ${archiving.name}?`}
          sub="Reversible - unarchive any time."
          confirmLabel="Archive domain"
          danger={false}
          busy={archive.isPending}
          onConfirm={() => archive.mutate(archiving.id)}
          onCancel={() => setArchiving(null)}
        >
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            Sending from <code className="font-mono">@{archiving.name}</code> stops immediately -
            the API rejects new sends for it. The email history, scoped keys, and templates stay
            exactly as they are, and unarchiving re-verifies DNS and turns sending back on.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
