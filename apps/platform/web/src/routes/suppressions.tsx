import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorNote, Input, PageHeader, Table } from '@/lib/ui';

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

function SuppressionsPage(): ReactElement {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [address, setAddress] = useState('');
  const rows = useQuery({
    queryKey: ['suppressions', q],
    queryFn: () => api.get<SuppressionRow[]>(`/api/suppressions?q=${encodeURIComponent(q)}`),
  });
  const add = useMutation({
    mutationFn: () => api.post('/api/suppressions', { address, reason: 'manual' }),
    onSuccess: () => {
      setAddress('');
      qc.invalidateQueries({ queryKey: ['suppressions'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/suppressions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suppressions'] }),
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (address) add.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Suppressions"
        sub="Suppressed addresses are blocked at the API boundary and never billed. Hard bounces, complaints, and unsubscribes land here automatically."
      />
      <Card>
        <div className="flex flex-wrap gap-3">
          <div className="min-w-64 flex-1">
            <Input placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <form onSubmit={submit} className="flex gap-3">
            <Input
              type="email"
              placeholder="suppress an address manually"
              value={address}
              onChange={e => setAddress(e.target.value)}
            />
            <Button type="submit" disabled={add.isPending}>
              Suppress
            </Button>
          </form>
        </div>
        <ErrorNote error={add.error ?? remove.error} />
      </Card>
      {rows.data?.length ? (
        <Table head={['Address', 'Reason', 'Scope', 'Added', '']}>
          {rows.data.map(s => (
            <tr key={s.id}>
              <td className="px-4 py-3 font-medium">{s.address}</td>
              <td className="px-4 py-3">
                <Badge status={s.reason === 'hard_bounce' ? 'bounced' : 'suppressed'} />
                <span className="ml-2 text-xs text-ink-soft">{s.reason}</span>
              </td>
              <td className="px-4 py-3 text-xs text-ink-soft">{s.domain_name ?? 'all domains'}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">{fmtTime(s.created_at)}</td>
              <td className="px-4 py-3 text-right">
                <Button variant="danger" onClick={() => remove.mutate(s.id)}>
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{rows.isLoading ? 'Loading…' : 'No suppressed addresses.'}</Empty>
      )}
    </div>
  );
}
