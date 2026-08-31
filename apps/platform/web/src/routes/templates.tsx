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
  Field,
  Input,
  Modal,
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
 * Double-buffered preview: rewriting one iframe's srcdoc reloads its document
 * and flashes white on every keystroke. Instead, write the new content into
 * the hidden back-buffer iframe and swap the two only once it has loaded -
 * the visible document is never mid-reload.
 */
function PreviewFrame({ html }: { html: string }): ReactElement {
  const frameA = useRef<HTMLIFrameElement>(null);
  const frameB = useRef<HTMLIFrameElement>(null);
  const frontRef = useRef<0 | 1>(0);
  const [front, setFront] = useState<0 | 1>(0);
  useEffect(() => {
    const t = setTimeout(() => {
      const back = frontRef.current === 0 ? 1 : 0;
      const el = (back === 0 ? frameA : frameB).current;
      if (!el) return;
      const onLoad = (): void => {
        el.removeEventListener('load', onLoad);
        frontRef.current = back;
        setFront(back);
      };
      el.addEventListener('load', onLoad);
      el.setAttribute('srcdoc', html);
    }, 250);
    return () => clearTimeout(t);
  }, [html]);
  const frameClass = (visible: boolean): string =>
    `absolute inset-0 h-full w-full bg-white ${visible ? '' : 'invisible'}`;
  return (
    <div className="relative min-h-0 flex-1 bg-white">
      <iframe ref={frameA} title="preview" sandbox="" className={frameClass(front === 0)} />
      <iframe ref={frameB} title="preview buffer" sandbox="" className={frameClass(front === 1)} />
    </div>
  );
}

/** Sends the sample-filled preview to a real inbox through the dashboard's
 *  test-send endpoint. Outside the email log by design. */
function TestSendModal({
  subject,
  html,
  text,
  domains,
  defaultDomainId,
  onClose,
}: {
  subject: string;
  html: string | null;
  text: string | null;
  domains: { id: string; name: string }[];
  defaultDomainId: string;
  onClose: () => void;
}): ReactElement {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ email: string }>('/api/me'),
    staleTime: Infinity,
  });
  const [to, setTo] = useState('');
  const [domainId, setDomainId] = useState(
    domains.some(d => d.id === defaultDomainId) ? defaultDomainId : (domains[0]?.id ?? '')
  );
  useEffect(() => {
    if (me.data?.email) setTo(prev => prev || me.data.email);
  }, [me.data]);

  const send = useMutation({
    mutationFn: () =>
      api.post('/api/test-send', { to, subject, html, text, domain_id: domainId }),
  });

  return (
    <Modal
      title="Send a test email"
      sub="Sends the preview - sample values filled in - to a real inbox."
      onClose={onClose}
    >
      <div className="mt-4 space-y-4">
        <Field label="To">
          <Input
            type="email"
            placeholder="you@example.com"
            value={to}
            onChange={e => setTo(e.target.value)}
          />
        </Field>
        <Field label="From domain">
          {domains.length ? (
            <Dropdown
              full
              value={domainId}
              onChange={setDomainId}
              options={domains.map(d => ({ value: d.id, label: d.name }))}
            />
          ) : (
            <p className="rounded-[10px] bg-warn-soft px-3.5 py-2.5 text-xs leading-relaxed text-warn">
              No active domain - verify &amp; activate one on the Domains page first.
            </p>
          )}
        </Field>
        <p className="text-xs leading-relaxed text-ink-soft">
          Arrives with a <b>[Test]</b> subject prefix. Test sends skip the email log and
          webhooks; sends to your account's verified destination addresses don't count against
          the daily quota.
        </p>
        <ErrorNote error={send.error} />
        {send.isSuccess && (
          <p className="rounded-[10px] bg-ok-soft px-3.5 py-2.5 text-xs font-semibold text-ok">
            Sent - check {to}.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {send.isSuccess ? 'Done' : 'Cancel'}
          </Button>
          <Button
            onClick={() => send.mutate()}
            disabled={send.isPending || !to || !domains.length}
          >
            {send.isPending ? 'Sending…' : send.isSuccess ? 'Send again' : 'Send test email'}
          </Button>
        </div>
      </div>
    </Modal>
  );
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
  const [testing, setTesting] = useState(false);

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

  // Escape closes the editor (unless a dialog is up - each handles its own).
  useEffect(() => {
    if (!editing || deleting || testing) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEditing(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, deleting, testing]);

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
                <Button
                  variant="ghost"
                  onClick={() => setTesting(true)}
                  disabled={!form.subject || (!form.html.trim() && !form.text.trim())}
                >
                  Send test
                </Button>
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

      {testing && (
        <TestSendModal
          subject={previewSubject}
          html={form.html.trim() ? previewHtml : null}
          text={form.text.trim() ? fillVars(form.text) : null}
          domains={(domains.data ?? [])
            .filter(d => d.status === 'active')
            .map(d => ({ id: d.id, name: d.name }))}
          defaultDomainId={form.domain_id}
          onClose={() => setTesting(false)}
        />
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
