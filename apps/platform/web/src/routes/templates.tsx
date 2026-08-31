import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import {
  Button,
  ConfirmDialog,
  Dropdown,
  Empty,
  ErrorNote,
  PageHeader,
  Segmented,
  Table,
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

const CodeEditor = lazy(() => import('@/lib/code-editor'));

function EditorFallback(): ReactElement {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center bg-card text-xs text-ink-soft">
      Loading editor…
    </div>
  );
}

/** Sample values substituted into the live preview. */
const SAMPLE: Record<string, string> = {
  name: 'Shiva',
  product: 'Acme',
  company: 'Acme',
  email: 'shiva@example.com',
  cta_url: '#',
  url: '#',
};
const fillVars = (s: string): string =>
  s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, v: string) => SAMPLE[v] ?? `[${v}]`);

/**
 * Chrome does not reliably re-navigate an iframe when React rewrites its
 * srcDoc attribute mid-typing, so drive srcdoc imperatively (debounced).
 */
function PreviewFrame({ html }: { html: string }): ReactElement {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.removeAttribute('srcdoc');
      el.setAttribute('srcdoc', html);
    }, 250);
    return () => clearTimeout(t);
  }, [html]);
  return <iframe ref={ref} title="preview" sandbox="" className="min-h-0 flex-1 bg-white" />;
}

function railField(label: string, control: ReactElement): ReactElement {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
        {label}
      </span>
      {control}
    </label>
  );
}

const railInput =
  'w-full rounded-[10px] border border-line bg-card px-3 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-soft/45 focus:border-accent focus:ring-2 focus:ring-accent/15';

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
  const [bodyTab, setBodyTab] = useState<'html' | 'text'>('html');
  const [deleting, setDeleting] = useState<TemplateRow | null>(null);

  const openNew = (): void => {
    setForm(empty);
    setBodyTab('html');
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
    setBodyTab('html');
    setEditing(t);
    save.reset();
  };

  const save = useMutation({
    mutationFn: () => {
      // trimEnd drops the editor's cosmetic blank-line padding before saving
      const body = {
        ...form,
        html: form.html.trimEnd() || null,
        text: form.text.trimEnd() || null,
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

  // Escape closes the editor (unless the delete dialog is up - it handles its own).
  useEffect(() => {
    if (!editing || deleting) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEditing(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, deleting]);

  const previewHtml = useMemo(() => fillVars(form.html), [form.html]);
  const previewSubject = useMemo(() => fillVars(form.subject), [form.subject]);

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
        <div className="fixed inset-0 z-50 bg-[#1c1916]/30 backdrop-blur-[1px]">
          <div className="absolute inset-3.5 flex flex-col overflow-hidden rounded-[14px] border border-line-soft bg-card shadow-[0_32px_80px_-20px_rgba(30,25,18,0.5)]">
            {/* header */}
            <div className="flex items-center gap-3.5 border-b border-line-soft px-5 py-3">
              <span className="text-sm font-semibold">
                {editing === 'new' ? 'New template' : `Edit ${(editing as TemplateRow).slug}`}
              </span>
              <span className="font-mono text-[10.5px] text-ink-soft">
                {editing === 'new'
                  ? 'saves as v1'
                  : `v${(editing as TemplateRow).version} → v${(editing as TemplateRow).version + 1} on save`}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <ErrorNote error={save.error} />
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button onClick={() => save.mutate()} disabled={save.isPending || !form.slug || !form.name || !form.subject}>
                  {save.isPending ? 'Saving…' : editing === 'new' ? 'Create template' : 'Save changes'}
                </Button>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setEditing(null)}
                  className="rounded-lg p-1.5 text-ink-soft transition hover:bg-paper hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {/* body: rail | editor | preview */}
            <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_1fr]">
              <div className="space-y-4 overflow-y-auto border-r border-line-soft bg-paper px-4 py-4">
                {railField(
                  'Slug',
                  <input
                    className={railInput}
                    placeholder="welcome-email"
                    value={form.slug}
                    onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                  />
                )}
                {railField(
                  'Name',
                  <input
                    className={railInput}
                    placeholder="Welcome email"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                )}
                {railField(
                  'Subject ({{variables}} allowed)',
                  <textarea
                    className={`${railInput} min-h-[64px] resize-y leading-relaxed`}
                    placeholder="Welcome to {{product}}!"
                    value={form.subject}
                    onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                  />
                )}
                {railField(
                  'Scope',
                  <Dropdown
                    full
                    value={form.domain_id}
                    onChange={v => setForm(f => ({ ...f, domain_id: v }))}
                    options={[
                      { value: '', label: 'Shared (all domains)' },
                      ...scopable.map(d => ({ value: d.id, label: d.name })),
                    ]}
                  />
                )}
                <p className="text-[11px] leading-relaxed text-ink-soft">
                  Variables like{' '}
                  <span className="font-mono text-accent-deep">{'{{name}}'}</span> are declared
                  automatically from the body and validated at send time.
                </p>
              </div>
              <div className="flex min-w-0 flex-col border-r border-line-soft">
                <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
                    Body
                  </span>
                  <Segmented options={['html', 'text'] as const} value={bodyTab} onChange={setBodyTab} />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <Suspense fallback={<EditorFallback />}>
                    {bodyTab === 'html' ? (
                      <CodeEditor
                        lang="html"
                        value={form.html}
                        onChange={v => setForm(f => ({ ...f, html: v }))}
                        height="100%"
                        placeholder="<h1>Hi {{name}}</h1>"
                      />
                    ) : (
                      <CodeEditor
                        lang="text"
                        value={form.text}
                        onChange={v => setForm(f => ({ ...f, text: v }))}
                        height="100%"
                        placeholder="Hi {{name}}"
                      />
                    )}
                  </Suspense>
                </div>
              </div>
              <div className="flex min-w-0 flex-col bg-paper">
                <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
                    Preview
                  </span>
                  <span className="font-mono text-[10px] text-ink-soft">sample values</span>
                </div>
                <div className="truncate border-b border-line-soft bg-white px-4 py-2 text-xs font-semibold text-ink">
                  {previewSubject || <span className="font-normal text-ink-soft">(no subject)</span>}
                </div>
                {form.html ? (
                  <PreviewFrame html={previewHtml} />
                ) : (
                  <pre className="min-h-0 flex-1 overflow-auto bg-white px-4 py-3 font-mono text-xs leading-relaxed text-ink">
                    {fillVars(form.text) || '(empty)'}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
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
