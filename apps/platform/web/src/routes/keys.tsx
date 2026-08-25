import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { Button, Card, Empty, ErrorNote, Field, Input, Table } from '@/lib/ui';

export const Route = createFileRoute('/keys')({
  component: KeysPage,
});

interface KeyRow {
  id: string;
  name: string;
  key_prefix: string;
  domain_name: string | null;
  last_used_at: number | null;
  created_at: number;
  revoked_at: number | null;
}

function KeysPage(): ReactElement {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => api.get<KeyRow[]>('/api/keys') });
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/api/domains'),
  });
  const [name, setName] = useState('');
  const [domainId, setDomainId] = useState('');
  const [minted, setMinted] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; key: string }>('/api/keys', {
        name,
        ...(domainId ? { domain_id: domainId } : {}),
      }),
    onSuccess: data => {
      setMinted(data.key);
      setName('');
      qc.invalidateQueries({ queryKey: ['keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['keys'] }),
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (name) create.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="font-display text-2xl font-semibold">API keys</h1>
      <Card title="Create a key">
        <form onSubmit={submit} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="Name">
              <Input placeholder="production backend" value={name} onChange={e => setName(e.target.value)} />
            </Field>
          </div>
          <div className="w-64">
            <Field label="Scope">
              <select
                className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm"
                value={domainId}
                onChange={e => setDomainId(e.target.value)}
              >
                <option value="">All domains</option>
                {domains.data?.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} only
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </form>
        <p className="mt-3 text-xs text-ink-soft">
          A scoped key can only send from its domain, and only sees that domain's emails,
          templates, and suppressions. Prefer scoped keys for anything embedded in an app.
        </p>
        {minted && (
          <div className="mt-4 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3">
            <p className="text-xs font-semibold text-accent-deep">
              Copy this key now - it is shown exactly once:
            </p>
            <code className="mt-1 block select-all break-all font-mono text-sm">{minted}</code>
          </div>
        )}
        <ErrorNote error={create.error ?? revoke.error} />
      </Card>
      {keys.data?.length ? (
        <Table head={['Name', 'Key', 'Scope', 'Last used', '']}>
          {keys.data.map(k => (
            <tr key={k.id} className={k.revoked_at ? 'opacity-50' : ''}>
              <td className="px-4 py-3 font-medium">{k.name}</td>
              <td className="px-4 py-3 font-mono text-xs">{k.key_prefix}…</td>
              <td className="px-4 py-3 text-xs text-ink-soft">{k.domain_name ?? 'all domains'}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">
                {k.revoked_at ? `revoked ${fmtTime(k.revoked_at)}` : fmtTime(k.last_used_at)}
              </td>
              <td className="px-4 py-3 text-right">
                {!k.revoked_at && (
                  <Button variant="danger" onClick={() => revoke.mutate(k.id)}>
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{keys.isLoading ? 'Loading…' : 'No keys yet.'}</Empty>
      )}
    </div>
  );
}
