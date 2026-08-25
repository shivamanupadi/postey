import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Table } from '@/lib/ui';

export const Route = createFileRoute('/webhooks')({
  component: WebhooksPage,
});

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events_json: string;
  enabled: number;
  created_at: number;
}

const ALL_EVENTS = ['email.delivered', 'email.bounced', 'email.failed', 'email.suppressed'];

function WebhooksPage(): ReactElement {
  const qc = useQueryClient();
  const hooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.get<WebhookRow[]>('/api/webhooks'),
  });
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([...ALL_EVENTS]);
  const create = useMutation({
    mutationFn: () => api.post<{ id: string; secret: string }>('/api/webhooks', { url, events }),
    onSuccess: () => {
      setUrl('');
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (h: WebhookRow) => api.put(`/api/webhooks/${h.id}`, { enabled: !h.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/webhooks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (url && events.length) create.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="font-display text-2xl font-semibold">Webhooks</h1>
      <Card title="Add an endpoint">
        <form onSubmit={submit} className="space-y-4">
          <Field label="URL">
            <Input
              type="url"
              required
              placeholder="https://api.yourapp.com/postey"
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {ALL_EVENTS.map(ev => (
              <button
                key={ev}
                type="button"
                onClick={() =>
                  setEvents(list => (list.includes(ev) ? list.filter(x => x !== ev) : [...list, ev]))
                }
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                  events.includes(ev)
                    ? 'border-accent bg-accent-soft text-accent-deep'
                    : 'border-line text-ink-soft'
                }`}
              >
                {ev}
              </button>
            ))}
          </div>
          <ErrorNote error={create.error} />
          <Button type="submit" disabled={create.isPending}>
            Add webhook
          </Button>
        </form>
        <p className="mt-3 text-xs leading-relaxed text-ink-soft">
          Deliveries are signed: verify the <code className="font-mono">Postey-Signature</code>{' '}
          header (HMAC-SHA256 of the raw body with the endpoint secret, hex, prefixed{' '}
          <code className="font-mono">sha256=</code>).
        </p>
      </Card>
      {hooks.data?.length ? (
        <Table head={['Endpoint', 'Events', 'Secret', 'Status', '']}>
          {hooks.data.map(h => (
            <tr key={h.id}>
              <td className="max-w-64 truncate px-4 py-3 font-mono text-xs">{h.url}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">
                {(JSON.parse(h.events_json) as string[]).join(', ')}
              </td>
              <td className="px-4 py-3">
                <code className="select-all font-mono text-xs">{h.secret}</code>
              </td>
              <td className="px-4 py-3">
                <Badge status={h.enabled ? 'active' : 'canceled'} />
              </td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => toggle.mutate(h)}>
                    {h.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="danger" onClick={() => remove.mutate(h.id)}>
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{hooks.isLoading ? 'Loading…' : 'No webhooks configured.'}</Empty>
      )}
    </div>
  );
}
