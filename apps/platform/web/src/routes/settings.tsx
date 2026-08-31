import { useEffect, useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button, Card, ErrorNote, Field, Input, PageHeader } from '@/lib/ui';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage(): ReactElement {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Record<string, string>>('/api/settings'),
  });
  const config = useQuery({
    queryKey: ['config'],
    queryFn: async () => {
      const res = await fetch('/api/config');
      return (await res.json()) as {
        sendUrl: string | null;
        sendingDomain: string | null;
        version: string | null;
      };
    },
  });

  const [form, setForm] = useState({
    retention_days: '',
    default_from: '',
    inbound_forward: '',
    quota_daily_limit: '',
  });
  useEffect(() => {
    if (settings.data) {
      setForm({
        retention_days: settings.data.retention_days ?? '',
        default_from: settings.data.default_from ?? '',
        inbound_forward: settings.data.inbound_forward ?? '',
        quota_daily_limit: settings.data.quota_daily_limit ?? '',
      });
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api.put(
        '/api/settings',
        Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v || null]))
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    save.mutate();
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Settings" sub="Instance details and sending configuration." />

      <Card title="Instance">
        <dl className="space-y-2 text-sm">
          {[
            ['Version', config.data?.version ?? 'dev'],
            ['Send API', config.data?.sendUrl ?? '-'],
            ['Sending domain', config.data?.sendingDomain ?? '-'],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-36 shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                {k}
              </dt>
              <dd className="font-mono text-xs">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Configuration">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Body retention (days, empty = keep forever)">
            <Input type="number" min={1} value={form.retention_days} onChange={set('retention_days')} />
          </Field>
          <Field label="Default from address">
            <Input placeholder="Acme <hello@mail.example.com>" value={form.default_from} onChange={set('default_from')} />
          </Field>
          <Field label="Inbound forward (verified destination address)">
            <Input type="email" placeholder="you@example.com" value={form.inbound_forward} onChange={set('inbound_forward')} />
          </Field>
          <Field label="Daily quota override (empty = discovered automatically)">
            <Input type="number" min={1} value={form.quota_daily_limit} onChange={set('quota_daily_limit')} />
          </Field>
          <ErrorNote error={save.error} />
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
