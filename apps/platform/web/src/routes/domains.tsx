import { useState, type ReactElement, type FormEvent, type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  Empty,
  ErrorNote,
  Field,
  FilterChip,
  Input,
  Modal,
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

/** Verify & activate (and unarchive, which re-verifies): live DNS checks,
 *  the exact Cloudflare onboarding steps, and the activation itself - with
 *  its loader and errors kept inside this modal. */
function VerifyActivateModal({ d, onClose }: { d: DomainRow; onClose: () => void }): ReactElement {
  const qc = useQueryClient();
  const unarchiving = d.status === 'archived';
  const checks = useQuery({
    queryKey: ['domain-checks', d.id],
    queryFn: () =>
      api.get<{ spf: boolean; dkim: boolean; mx: boolean }>(`/api/domains/${d.id}/checks`),
    staleTime: 10_000,
  });
  const activate = useMutation({
    mutationFn: () => api.post(`/api/domains/${d.id}/activate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains'] });
      onClose();
    },
  });
  const c = checks.data;
  const dnsReady = Boolean(c && c.spf && c.dkim && c.mx);

  return (
    <Modal
      title={unarchiving ? `Unarchive ${d.name}` : `Verify & activate ${d.name}`}
      sub={
        unarchiving
          ? 'Re-verifies the onboarding DNS, then turns sending back on.'
          : "Sending turns on once Cloudflare's onboarding records are live."
      }
      onClose={onClose}
    >
      <div className="mt-4 space-y-4">
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[12.5px] font-semibold text-ink">Onboarding DNS</h3>
            <button
              type="button"
              onClick={() => void qc.invalidateQueries({ queryKey: ['domain-checks', d.id] })}
              className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft transition hover:bg-card hover:text-ink"
            >
              {checks.isFetching ? 'Checking…' : 'Re-check'}
            </button>
          </div>
          <div className="divide-y divide-[#efe8dc] rounded-[10px] border border-line-soft bg-paper px-3.5 py-1">
            <CheckRow ok={c ? c.spf : null} label="cf-bounce TXT (SPF)" />
            <CheckRow ok={c ? c.dkim : null} label="cf-bounce._domainkey (DKIM)" />
            <CheckRow ok={c ? c.mx : null} label="cf-bounce MX" />
          </div>
        </section>

        {!dnsReady && (
          <section className="rounded-[10px] bg-warn-soft px-4 py-3.5">
            <h3 className="text-[12.5px] font-semibold text-warn">
              Records missing - onboard the domain in Cloudflare first
            </h3>
            <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12px] leading-relaxed text-ink">
              <li>
                Open{' '}
                <a
                  className="font-semibold text-accent-deep underline"
                  href="https://dash.cloudflare.com/?to=/:account/email-service/sending"
                  target="_blank"
                  rel="noreferrer"
                >
                  Email Service → Email Sending
                </a>{' '}
                in the Cloudflare dashboard (the account that owns this zone).
              </li>
              <li>
                Click <b>Onboard domain</b> and choose <b className="font-mono">{d.name}</b>.
              </li>
              <li>
                Confirm - Cloudflare creates and locks the three cf-bounce records itself.
                There is nothing to copy or paste manually.
              </li>
              <li>
                Give DNS a minute or two, hit <b>Re-check</b> above, then verify below.
              </li>
            </ol>
            <p className="mt-2 font-mono text-[10.5px] text-ink-soft">
              CLI alternative: npx wrangler email sending enable {d.name}
            </p>
          </section>
        )}

        <ErrorNote error={activate.error} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => activate.mutate()} disabled={activate.isPending}>
            {activate.isPending
              ? 'Verifying…'
              : unarchiving
                ? 'Verify & unarchive'
                : 'Verify & activate'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DomainsPage(): ReactElement {
  const qc = useQueryClient();
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<DomainRow[]>('/api/domains'),
  });
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<'active' | 'pending' | 'archived' | 'all'>('active');
  const [deleting, setDeleting] = useState<DomainRow | null>(null);
  const [archiving, setArchiving] = useState<DomainRow | null>(null);
  const [inspecting, setInspecting] = useState<DomainRow | null>(null);
  const [verifying, setVerifying] = useState<DomainRow | null>(null);

  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['domains'] });
  const add = useMutation({
    mutationFn: () => api.post('/api/domains', { name }),
    onSuccess: () => {
      setName('');
      setAdding(false);
      refresh();
    },
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

  const visible =
    filter === 'all' ? (domains.data ?? []) : (domains.data ?? []).filter(d => d.status === filter);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Domains"
        sub="Domains this instance may send from. Each needs Email Sending onboarding on Cloudflare's side."
        action={
          <Button
            onClick={() => {
              setName('');
              add.reset();
              setAdding(true);
            }}
          >
            Add domain
          </Button>
        }
      />
      <ErrorNote error={archive.error ?? remove.error} />

      <div className="flex flex-wrap gap-1.5">
        <FilterChip
          active={filter === 'active'}
          onClick={() => setFilter('active')}
          label="Active"
          count={domains.data?.filter(d => d.status === 'active').length ?? 0}
          dot="bg-ok"
        />
        <FilterChip
          active={filter === 'pending'}
          onClick={() => setFilter('pending')}
          label="Pending"
          count={domains.data?.filter(d => d.status === 'pending').length ?? 0}
          dot="bg-warn"
        />
        <FilterChip
          active={filter === 'archived'}
          onClick={() => setFilter('archived')}
          label="Archived"
          count={domains.data?.filter(d => d.status === 'archived').length ?? 0}
          dot="bg-ink-soft"
        />
        <FilterChip
          active={filter === 'all'}
          onClick={() => setFilter('all')}
          label="All"
          count={domains.data?.length ?? 0}
        />
      </div>

      {visible.length ? (
        <Table head={['Domain', 'Status', 'Emails', 'Added', '']}>
          {visible.map(d => (
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
                    <Button variant="ghost" onClick={() => setVerifying(d)}>
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
        <Empty>
          {domains.isLoading
            ? 'Loading…'
            : filter === 'all'
              ? 'No domains yet.'
              : `No ${filter} domains.`}
        </Empty>
      )}

      {adding && (
        <Modal
          title="Add a sending domain"
          sub="Registers the domain on this instance."
          onClose={() => setAdding(false)}
        >
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Domain">
              <Input
                autoFocus
                placeholder="mail.example.com"
                className="font-mono text-[13px]"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </Field>
            <p className="text-xs leading-relaxed text-ink-soft">
              Next, onboard it to Email Sending in the{' '}
              <a
                className="font-medium text-accent hover:underline"
                href="https://dash.cloudflare.com/?to=/:account/email-service/sending"
                target="_blank"
                rel="noreferrer"
              >
                Cloudflare dashboard
              </a>{' '}
              (Email Service &rarr; Onboard Domain), then use <b>Verify &amp; activate</b> from the
              table - the DNS check runs automatically.
            </p>
            <ErrorNote error={add.error} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={add.isPending || !name}>
                Add domain
              </Button>
            </div>
          </form>
        </Modal>
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

      {verifying && <VerifyActivateModal d={verifying} onClose={() => setVerifying(null)} />}

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
