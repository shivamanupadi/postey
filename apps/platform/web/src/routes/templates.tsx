import { lazy, Suspense, useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import {
  Button,
  ConfirmDialog,
  Dropdown,
  Empty,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Table,
  Textarea,
} from '@/lib/ui';

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

const HtmlEditor = lazy(() => import('@/lib/html-editor'));

function EditorFallback(): ReactElement {
  return (
    <div className="flex h-[240px] items-center justify-center rounded-[10px] border border-line bg-card text-xs text-ink-soft">
      Loading editor…
    </div>
  );
}

function TemplatesPage(): ReactElement {
  const qc = useQueryClient();
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<TemplateRow[]>('/api/templates'),
  });
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string; status: string }[]>('/api/domains'),
  });
  const scopable = domains.data?.filter(d => d.status !== 'archived') ?? [];

  const [editing, setEditing] = useState<TemplateRow | 'new' | null>(null);
  const [form, setForm] = useState(empty);
  const [deleting, setDeleting] = useState<TemplateRow | null>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const openNew = (): void => {
    setForm(empty);
    setEditing('new');
    save.reset();
  };
  const openEdit = (t: TemplateRow): void => {
    setForm({
      slug: t.slug,
      name: t.name,
      subject: t.subject,
      html: t.html ?? '',
      text: t.text ?? '',
      domain_id: t.domain_id ?? '',
    });
    setEditing(t);
    save.reset();
  };

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
        : api.put(`/api/templates/${(editing as TemplateRow).id}`, body);
    },
    onSuccess: () => {
      setEditing(null);
      setForm(empty);
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/templates/${id}`),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Templates"
        sub="Versioned templates with {{variables}}, validated at send time. Send by slug instead of shipping HTML."
        action={<Button onClick={openNew}>New template</Button>}
      />

      {templates.data?.length ? (
        <Table head={['Template', 'Subject', 'Scope', 'Version', 'Updated', '']}>
          {templates.data.map(t => (
            <tr key={t.id}>
              <td className="px-4 py-3">
                <p className="font-medium">{t.name}</p>
                <p className="font-mono text-xs text-ink-soft">{t.slug}</p>
              </td>
              <td className="max-w-[220px] truncate px-4 py-3 text-ink-soft">{t.subject}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">{t.domain_name ?? 'shared'}</td>
              <td className="px-4 py-3 font-mono text-xs">v{t.version}</td>
              <td className="px-4 py-3 text-xs text-ink-soft">{fmtTime(t.updated_at)}</td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => openEdit(t)}>
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => setDeleting(t)}>
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>
          {templates.isLoading ? 'Loading…' : 'No templates yet - create one to send by slug.'}
        </Empty>
      )}

      {editing && (
        <Modal
          title={editing === 'new' ? 'New template' : `Edit ${(editing as TemplateRow).slug}`}
          sub={
            editing === 'new'
              ? 'Sends can reference it by slug the moment it saves.'
              : `Currently v${(editing as TemplateRow).version} - saving publishes v${(editing as TemplateRow).version + 1}.`
          }
          onClose={() => setEditing(null)}
        >
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Slug">
                <Input required placeholder="welcome-email" value={form.slug} onChange={set('slug')} />
              </Field>
              <Field label="Name">
                <Input required placeholder="Welcome email" value={form.name} onChange={set('name')} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <Field label="Subject ({{variables}} allowed)">
                <Input
                  required
                  placeholder="Welcome to {{product}}!"
                  value={form.subject}
                  onChange={set('subject')}
                />
              </Field>
              <Field label="Scope">
                <Dropdown
                  value={form.domain_id}
                  onChange={v => setForm(f => ({ ...f, domain_id: v }))}
                  options={[
                    { value: '', label: 'Shared (all domains)' },
                    ...scopable.map(d => ({ value: d.id, label: d.name })),
                  ]}
                />
              </Field>
            </div>
            <Field label="HTML">
              <Suspense fallback={<EditorFallback />}>
                <HtmlEditor value={form.html} onChange={v => setForm(f => ({ ...f, html: v }))} />
              </Suspense>
            </Field>
            <Field label="Text (plain-text part)">
              <Textarea rows={3} value={form.text} onChange={set('text')} placeholder="Hi {{name}}" />
            </Field>
            <ErrorNote error={save.error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : editing === 'new' ? 'Create template' : 'Save changes'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.slug}?`}
          sub="This cannot be undone."
          confirmLabel="Delete template"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        >
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            API requests that send with <code className="font-mono">template_id</code>{' '}
            <code className="font-mono">{deleting.slug}</code> start failing immediately. Emails
            already sent from it keep their stored bodies in the log.
          </p>
          <ErrorNote error={remove.error} />
        </ConfirmDialog>
      )}
    </div>
  );
}
