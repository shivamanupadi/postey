import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import {
  Button,
  ConfirmDialog,
  Dropdown,
  Empty,
  ErrorNote,
  Field,
  FilterChip,
  Input,
  Modal,
  PageHeader,
  Table,
} from '@/lib/ui';

export const Route = createFileRoute('/suppressions')({
  component: SuppressionsPage,
});

interface SuppressionRow {
  id: string;
  address: string;
  reason: string;
  domain_name: string | null;
  source_message_id: string | null;
  created_at: number;
}

const REASONS = [
  { key: 'hard_bounce', label: 'Hard bounce', dot: 'bg-bad' },
  { key: 'complaint', label: 'Complaint', dot: 'bg-[#9d2458]' },
  { key: 'unsubscribe', label: 'Unsubscribe', dot: 'bg-warn' },
  { key: 'manual', label: 'Manual', dot: 'bg-ink-soft' },
] as const;

const BADGE_TONE: Record<string, string> = {
  hard_bounce: 'bg-bad-soft text-bad',
  complaint: 'bg-[#fce7f0] text-[#9d2458]',
  unsubscribe: 'bg-warn-soft text-warn',
  manual: 'bg-paper-deep text-ink-soft',
};

function ReasonBadge({ reason }: { reason: string }): ReactElement {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold ${BADGE_TONE[reason] ?? 'bg-paper-deep text-ink-soft'}`}
    >
      {reason.replaceAll('_', ' ')}
    </span>
  );
}

/** Removals of bounce/complaint entries carry reputation risk - explain it. */
const REMOVE_WARNING: Record<string, string> = {
  hard_bounce:
    'This address hard-bounced. If the mailbox still does not exist, the next send bounces again and hurts your sender reputation - only remove it if you know the address is valid now.',
  complaint:
    'This recipient reported your email as spam. Emailing them again without their consent is very likely to trigger another complaint and damage deliverability for the whole domain.',
};

function SuppressionsPage(): ReactElement {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [domainId, setDomainId] = useState('');
  const [removing, setRemoving] = useState<SuppressionRow | null>(null);

  const rows = useQuery({
    queryKey: ['suppressions', q, reason],
    queryFn: () =>
      api.get<SuppressionRow[]>(
        `/api/suppressions?q=${encodeURIComponent(q)}&reason=${encodeURIComponent(reason)}`
      ),
  });
  const counts = useQuery({
    queryKey: ['suppression-counts'],
    queryFn: () => api.get<{ reason: string; n: number }[]>('/api/suppressions/counts'),
  });
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string; status: string }[]>('/api/domains'),
  });
  const scopable = domains.data?.filter(d => d.status === 'active') ?? [];

  const countFor = (key: string): number =>
    counts.data?.find(r => r.reason === key)?.n ?? 0;
  const total = counts.data?.reduce((sum, r) => sum + r.n, 0) ?? 0;

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['suppressions'] });
    void qc.invalidateQueries({ queryKey: ['suppression-counts'] });
  };
  const add = useMutation({
    mutationFn: () =>
      api.post('/api/suppressions', {
        address,
        reason: 'manual',
        domain_id: domainId || null,
      }),
    onSuccess: () => {
      setAddress('');
      setDomainId('');
      setAdding(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/suppressions/${id}`),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
  });

  const onRemove = (s: SuppressionRow): void => {
    remove.reset();
    // Bounce/complaint removals get a warning dialog; the rest are routine.
    if (s.reason in REMOVE_WARNING) setRemoving(s);
    else remove.mutate(s.id);
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (address) add.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Suppressions"
        sub="Suppressed addresses are blocked at the API boundary and never billed. Hard bounces, complaints, and unsubscribes land here automatically."
        action={
          <Button
            onClick={() => {
              setAddress('');
              setDomainId('');
              add.reset();
              setAdding(true);
            }}
          >
            Suppress address
          </Button>
        }
      />
      <ErrorNote error={remove.error && !removing ? remove.error : null} />

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={reason === ''} onClick={() => setReason('')} label="All" count={total} />
          {REASONS.map(r => (
            <FilterChip
              key={r.key}
              active={reason === r.key}
              onClick={() => setReason(r.key)}
              label={r.label}
              count={countFor(r.key)}
              dot={r.dot}
            />
          ))}
        </div>
        <div className="ml-auto flex min-w-56 items-center gap-2 rounded-[10px] border border-line bg-card px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-soft" />
          <input
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-soft/60"
            placeholder="Search address…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
        </div>
      </div>

      {rows.data?.length ? (
        <Table head={['Address', 'Reason', 'Scope', 'Source', 'Added', '']}>
          {rows.data.map(s => (
            <tr key={s.id}>
              <td className="px-4 py-3 font-medium">{s.address}</td>
              <td className="px-4 py-3">
                <ReasonBadge reason={s.reason} />
              </td>
              <td className="px-4 py-3 text-xs text-ink-soft">{s.domain_name ?? 'all domains'}</td>
              <td className="px-4 py-3">
                {s.source_message_id ? (
                  <Link
                    to="/emails/$id"
                    params={{ id: s.source_message_id }}
                    className="font-mono text-[10.5px] text-accent-deep hover:underline"
                  >
                    {s.source_message_id.slice(0, 8)}…
                  </Link>
                ) : (
                  <span className="font-mono text-[10.5px] text-ink-soft">-</span>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-ink-soft">{fmtTime(s.created_at)}</td>
              <td className="px-4 py-3 text-right">
                <Button variant="danger" onClick={() => onRemove(s)}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>
          {rows.isLoading
            ? 'Loading…'
            : q || reason
              ? 'No suppressions match these filters.'
              : 'No suppressed addresses.'}
        </Empty>
      )}

      {adding && (
        <Modal
          title="Suppress an address"
          sub="Sends to it are rejected at the API boundary."
          onClose={() => setAdding(false)}
        >
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Email address">
              <Input
                autoFocus
                type="email"
                className="font-mono text-[13px]"
                placeholder="person@example.com"
                value={address}
                onChange={e => setAddress(e.target.value)}
              />
            </Field>
            <Field label="Scope">
              <Dropdown
                full
                value={domainId}
                onChange={setDomainId}
                options={[
                  { value: '', label: 'All domains' },
                  ...scopable.map(d => ({ value: d.id, label: d.name })),
                ]}
              />
            </Field>
            <p className="text-xs leading-relaxed text-ink-soft">
              Recorded with reason <b>manual</b>. The address can be removed from this list at any
              time to make it sendable again.
            </p>
            <ErrorNote error={add.error} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={add.isPending || !address}>
                Suppress
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {removing && (
        <ConfirmDialog
          title="Remove suppression?"
          sub="The address becomes sendable again."
          confirmLabel="Remove suppression"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(removing.id)}
          onCancel={() => setRemoving(null)}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-[10px] border border-line-soft bg-paper px-3.5 py-3 text-xs">
            <dt className="text-ink-soft">Address</dt>
            <dd className="m-0 break-all font-mono text-[11.5px]">{removing.address}</dd>
            <dt className="text-ink-soft">Reason</dt>
            <dd className="m-0">
              <ReasonBadge reason={removing.reason} />
            </dd>
            <dt className="text-ink-soft">Added</dt>
            <dd className="m-0">{fmtTime(removing.created_at)}</dd>
          </dl>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">
            {REMOVE_WARNING[removing.reason]}
          </p>
          <ErrorNote error={remove.error} />
        </ConfirmDialog>
      )}
    </div>
  );
}
