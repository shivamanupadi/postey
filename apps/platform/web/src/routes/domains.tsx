import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorNote, Input, PageHeader, Table } from '@/lib/ui';

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
  /** Live cf-bounce DNS check: true = onboarded in Cloudflare, false = not yet. */
  dns_ready: boolean | null;
}

function DomainsPage(): ReactElement {
  const qc = useQueryClient();
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<DomainRow[]>('/api/domains'),
  });
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: () => api.post('/api/domains', { name }),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['domains'] });
    },
  });
  const activate = useMutation({
    mutationFn: (id: string) => api.post(`/api/domains/${id}/activate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/domains/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
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
            Add
          </Button>
        </form>
        <p className="mt-3 text-xs leading-relaxed text-ink-soft">
          Adding a domain here only registers it on this instance. Onboard it to Email Sending on
          Cloudflare's side - run{' '}
          <code className="font-mono">npx wrangler email sending enable &lt;domain&gt;</code> or use
          the{' '}
          <a
            className="text-accent underline"
            href="https://dash.cloudflare.com/?to=/:account/email-service/sending"
            target="_blank"
            rel="noreferrer"
          >
            Cloudflare dashboard
          </a>{' '}
          (Email Sending → Onboard Domain) - then Verify &amp; activate checks the onboarding DNS
          records before switching it on.
        </p>
        <ErrorNote error={add.error ?? activate.error ?? remove.error} />
      </Card>
      {domains.data?.length ? (
        <Table head={['Domain', 'Status', 'Emails', 'Added', '']}>
          {domains.data.map(d => (
            <tr key={d.id}>
              <td className="px-4 py-3 font-medium">{d.name}</td>
              <td className="px-4 py-3">
                <Badge status={d.status} />
                {d.status !== 'active' && d.dns_ready === true && (
                  <p className="mt-1 text-xs text-ok">DNS ready - activate now</p>
                )}
                {d.status !== 'active' && d.dns_ready === false && (
                  <p className="mt-1 text-xs text-ink-soft">awaiting Cloudflare onboarding</p>
                )}
              </td>
              <td className="px-4 py-3 font-mono text-xs">{d.message_count}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">{fmtTime(d.created_at)}</td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-2">
                  {d.status !== 'active' && (
                    <Button variant="ghost" onClick={() => activate.mutate(d.id)}>
                      Verify & activate
                    </Button>
                  )}
                  {d.message_count === 0 && (
                    <Button variant="danger" onClick={() => remove.mutate(d.id)}>
                      Delete
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{domains.isLoading ? 'Loading…' : 'No domains yet.'}</Empty>
      )}
    </div>
  );
}
