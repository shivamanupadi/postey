import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { lazy, Suspense } from 'react';
import { Code } from 'lucide-react';
import { Button, ConfirmDialog, Dropdown, Empty, ErrorNote, Field, Input, Modal, PageHeader, Segmented, Table } from '@/lib/ui';

const CodeEditor = lazy(() => import('@/lib/code-editor'));
const SNIPPET_LANG = { curl: 'shell', node: 'javascript', python: 'python', mcp: 'shell' } as const;

/* ── send snippets ──────────────────────────────────────────────── */

type Lang = 'curl' | 'node' | 'python' | 'mcp';

function buildSnippet(lang: Lang, sendUrl: string, key: string, from: string): string {
  const url = `${sendUrl}/api/emails`;
  switch (lang) {
    case 'curl':
      return `curl -X POST ${url} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "Acme <${from}>",
    "to": ["user@example.com"],
    "subject": "Hello from Postey",
    "html": "<h1>It works!</h1>"
  }'`;
    case 'node':
      return `const res = await fetch("${url}", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from: "Acme <${from}>",
    to: ["user@example.com"],
    subject: "Hello from Postey",
    html: "<h1>It works!</h1>",
  }),
});
const { id } = await res.json();`;
    case 'python':
      return `import requests

res = requests.post(
    "${url}",
    headers={
        "Authorization": "Bearer ${key}",
        "User-Agent": "my-app/1.0",  # bot protection dislikes default UAs
    },
    json={
        "from": "Acme <${from}>",
        "to": ["user@example.com"],
        "subject": "Hello from Postey",
        "html": "<h1>It works!</h1>",
    },
)
print(res.json()["id"])`;
    case 'mcp':
      return `# Give a coding agent its own email tools:
claude mcp add --transport http postey ${sendUrl}/api/mcp \\
  --header "Authorization: Bearer ${key}"`;
  }
}

function SendSnippets({ apiKey }: { apiKey: string | null }): ReactElement {
  const [lang, setLang] = useState<Lang>('curl');
  const [copied, setCopied] = useState(false);
  const config = useQuery({
    queryKey: ['instance-config'],
    queryFn: async () => {
      const res = await fetch('/api/config');
      return (await res.json()) as { sendUrl: string | null; sendingDomain: string | null };
    },
    staleTime: Infinity,
  });
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string; status: string }[]>('/api/domains'),
  });

  const sendUrl = config.data?.sendUrl ?? 'https://<your-send-worker>';
  const domain =
    domains.data?.find(d => d.status === 'active')?.name ??
    config.data?.sendingDomain ??
    'your-domain.com';
  const snippet = buildSnippet(lang, sendUrl, apiKey ?? '<YOUR_API_KEY>', `hello@${domain}`);

  const copy = (): void => {
    void navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between">
        <Segmented options={['curl', 'node', 'python', 'mcp'] as const} value={lang} onChange={setLang} />
        <button
          onClick={copy}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            copied
              ? 'bg-accent-soft text-accent-deep'
              : 'border border-line text-ink-soft hover:bg-card hover:text-ink'
          }`}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-line">
        <Suspense
          fallback={
            <div className="flex h-[220px] items-center justify-center bg-card text-xs text-ink-soft">
              Loading…
            </div>
          }
        >
          <CodeEditor value={snippet} lang={SNIPPET_LANG[lang]} readOnly height="240px" />
        </Suspense>
      </div>
    </div>
  );
}

function CopyKey({ value }: { value: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`shrink-0 rounded-lg border px-3.5 py-2 text-xs font-bold transition ${
        copied
          ? 'border-transparent bg-accent text-white'
          : 'border-accent/35 bg-white text-accent-deep hover:bg-accent-soft'
      }`}
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

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
    queryFn: () => api.get<{ id: string; name: string; status: string }[]>('/api/domains'),
  });
  const scopable = domains.data?.filter(d => d.status !== 'archived');
  const [name, setName] = useState('');
  const [domainId, setDomainId] = useState('');
  const [creating, setCreating] = useState(false);
  /** Copy-once key from the last create, shown inside the create modal. */
  const [minted, setMinted] = useState<{ key: string; name: string; scope: string } | null>(null);
  const [revoking, setRevoking] = useState<KeyRow | null>(null);
  const [howto, setHowto] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; key: string }>('/api/keys', {
        name,
        ...(domainId ? { domain_id: domainId } : {}),
      }),
    onSuccess: data => {
      setMinted({
        key: data.key,
        name,
        scope: scopable?.find(d => d.id === domainId)?.name ?? 'all domains',
      });
      setName('');
      setDomainId('');
      qc.invalidateQueries({ queryKey: ['keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/keys/${id}`),
    onSuccess: () => {
      setRevoking(null);
      qc.invalidateQueries({ queryKey: ['keys'] });
    },
  });
  const closeCreate = (): void => {
    setCreating(false);
    setMinted(null);
    create.reset();
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (name) create.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="API keys"
        sub="Keys are hashed at rest and shown once. Scope them to a domain wherever you can."
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setHowto(true)}
              className="flex items-center gap-2 whitespace-nowrap rounded-[10px] border border-line bg-card px-3.5 py-2 text-[13.5px] font-medium text-ink transition hover:bg-paper"
            >
              <Code className="h-4 w-4 text-ink-soft" />
              How to send
            </button>
            <Button
              onClick={() => {
                setName('');
                setDomainId('');
                create.reset();
                setMinted(null);
                setCreating(true);
              }}
            >
              Create key
            </Button>
          </div>
        }
      />
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
                  <Button
                    variant="danger"
                    onClick={() => {
                      revoke.reset();
                      setRevoking(k);
                    }}
                  >
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

      {creating && !minted && (
        <Modal
          title="Create an API key"
          sub="Shown once, then only its prefix."
          onClose={closeCreate}
        >
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Name">
              <Input
                autoFocus
                placeholder="production backend"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </Field>
            <Field label="Scope">
              <Dropdown
                value={domainId}
                onChange={setDomainId}
                options={[
                  { value: '', label: 'All domains' },
                  ...(scopable ?? []).map(d => ({ value: d.id, label: d.name })),
                ]}
              />
            </Field>
            <p className="text-xs leading-relaxed text-ink-soft">
              A scoped key can only send from its domain, and only sees that domain's emails,
              templates, and suppressions. Prefer scoped keys for anything embedded in an app.
            </p>
            <ErrorNote error={create.error} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" type="button" onClick={closeCreate}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name}>
                Create key
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {creating && minted && (
        <Modal
          title={
            <span className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ok-soft text-sm font-bold text-ok">
                ✓
              </span>
              {minted.name} created
            </span>
          }
          sub={minted.scope === 'all domains' ? 'Valid for all domains' : `Scoped to ${minted.scope}`}
          onClose={closeCreate}
        >
          <div className="mt-4 rounded-xl bg-accent-soft px-4 py-3.5 ring-1 ring-accent/25">
            <p className="text-xs font-semibold text-accent-deep">
              Copy this key now - it is shown exactly once:
            </p>
            <div className="mt-2 flex items-center gap-2.5">
              <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-accent/25 bg-white px-3 py-2 font-mono text-[12.5px]">
                {minted.key}
              </code>
              <CopyKey value={minted.key} />
            </div>
            <p className="mt-2 text-[11px] text-ink-soft">
              Lost keys cannot be recovered - revoke and mint a new one instead.
            </p>
          </div>
          <SendSnippets apiKey={minted.key} />
          <div className="mt-5 flex justify-end">
            <Button onClick={closeCreate}>Done</Button>
          </div>
        </Modal>
      )}

      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          sub="This cannot be undone."
          confirmLabel="Revoke key"
          busy={revoke.isPending}
          onConfirm={() => revoke.mutate(revoking.id)}
          onCancel={() => setRevoking(null)}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-[10px] border border-line-soft bg-paper px-3.5 py-3 text-xs">
            <dt className="text-ink-soft">Key</dt>
            <dd className="m-0 font-mono">{revoking.key_prefix}…</dd>
            <dt className="text-ink-soft">Scope</dt>
            <dd className="m-0 font-medium">{revoking.domain_name ?? 'all domains'}</dd>
            <dt className="text-ink-soft">Last used</dt>
            <dd className="m-0">{fmtTime(revoking.last_used_at)}</dd>
          </dl>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">
            Requests authenticated with this key are rejected immediately - anything still
            deployed with it stops sending. Emails already sent and their logs are kept.
          </p>
          <ErrorNote error={revoke.error} />
        </ConfirmDialog>
      )}

      {howto && (
        <Modal
          title="How to send"
          sub="Point your client at this instance's send API."
          onClose={() => setHowto(false)}
        >
          <p className="text-[13px] leading-relaxed text-ink-soft">
            POST Resend-shaped payloads to <code className="font-mono text-xs">/api/emails</code>{' '}
            with any key. Supports templates (template_id + variables), attachments (base64),
            idempotency keys, and scheduling - the mcp tab wires a coding agent to your
            instance's built-in MCP server.
          </p>
          <SendSnippets apiKey={null} />
        </Modal>
      )}
    </div>
  );
}
