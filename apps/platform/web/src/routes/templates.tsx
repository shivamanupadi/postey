import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { Button, Card, Empty, ErrorNote, Field, Input, Table, Textarea } from '@/lib/ui';

export const Route = createFileRoute('/templates')({
  component: TemplatesPage,
});

interface TemplateRow {
  id: string;
  slug: string;
  name: string;
  subject: string;
  html: string | null;
  text: string | null;
  domain_id: string | null;
  domain_name: string | null;
  version: number;
  updated_at: number;
}

const empty = { slug: '', name: '', subject: '', html: '', text: '', domain_id: '' };

function TemplatesPage(): ReactElement {
  const qc = useQueryClient();
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<TemplateRow[]>('/api/templates'),
  });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState(empty);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/api/domains'),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        html: form.html || null,
        text: form.text || null,
        domain_id: form.domain_id || null,
      };
      return editing === 'new'
        ? api.post('/api/templates', body)
        : api.put(`/api/templates/${editing}`, body);
    },
    onSuccess: () => {
      setEditing(null);
      setForm(empty);
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold">Templates</h1>
        <Button
          onClick={() => {
            setEditing('new');
            setForm(empty);
          }}
        >
          New template
        </Button>
      </div>

      {editing && (
        <Card title={editing === 'new' ? 'New template' : 'Edit template'}>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Slug">
                <Input required placeholder="welcome-email" value={form.slug} onChange={set('slug')} />
              </Field>
              <Field label="Name">
                <Input required placeholder="Welcome email" value={form.name} onChange={set('name')} />
              </Field>
            </div>
            <Field label="Subject ({{variables}} allowed)">
              <Input required placeholder="Welcome to {{product}}!" value={form.subject} onChange={set('subject')} />
            </Field>
            <Field label="Scope">
              <select
                className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm"
                value={form.domain_id}
                onChange={set('domain_id')}
              >
                <option value="">Shared (all domains)</option>
                {domains.data?.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} only
                  </option>
                ))}
              </select>
            </Field>
            <Field label="HTML">
              <Textarea rows={8} value={form.html} onChange={set('html')} placeholder="<h1>Hi {{name}}</h1>" />
            </Field>
            <Field label="Text">
              <Textarea rows={4} value={form.text} onChange={set('text')} placeholder="Hi {{name}}" />
            </Field>
            <ErrorNote error={save.error} />
            <div className="flex gap-3">
              <Button type="submit" disabled={save.isPending}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {templates.data?.length ? (
        <Table head={['Template', 'Subject', 'Scope', 'Version', 'Updated', '']}>
          {templates.data.map(t => (
            <tr key={t.id}>
              <td className="px-4 py-3">
                <p className="font-medium">{t.name}</p>
                <p className="font-mono text-xs text-ink-soft">{t.slug}</p>
              </td>
              <td className="px-4 py-3 text-ink-soft">{t.subject}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">{t.domain_name ?? 'shared'}</td>
              <td className="px-4 py-3 font-mono text-xs">v{t.version}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">{fmtTime(t.updated_at)}</td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(t.id);
                      setForm({
                        slug: t.slug,
                        name: t.name,
                        subject: t.subject,
                        html: t.html ?? '',
                        text: t.text ?? '',
                        domain_id: t.domain_id ?? '',
                      });
                    }}
                  >
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => remove.mutate(t.id)}>
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{templates.isLoading ? 'Loading…' : 'No templates yet.'}</Empty>
      )}
    </div>
  );
}
