import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { Button, Card, Empty, ErrorNote, Field, Input, PageHeader, Segmented, Select, Table } from '@/lib/ui';

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
      <pre className="mt-3 overflow-x-auto rounded-xl bg-ink-deep p-4 font-mono text-xs leading-relaxed text-cream/90">
        {snippet}
      </pre>
    </div>
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
      <PageHeader
        title="API keys"
        sub="Keys are hashed at rest and shown once. Scope them to a domain wherever you can."
      />
      <Card title="Create a key">
        <form onSubmit={submit} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="Name">
              <Input placeholder="production backend" value={name} onChange={e => setName(e.target.value)} />
            </Field>
          </div>
          <div className="w-64">
            <Field label="Scope">
              <Select value={domainId} onChange={e => setDomainId(e.target.value)}>
                <option value="">All domains</option>
                {domains.data?.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} only
                  </option>
                ))}
              </Select>
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
          <div className="mt-4 rounded-xl bg-accent-soft px-4 py-3.5 ring-1 ring-accent/25">
            <p className="text-xs font-semibold text-accent-deep">
              Copy this key now - it is shown exactly once:
            </p>
            <code className="mt-1 block select-all break-all font-mono text-sm">{minted}</code>
            <p className="mt-3 text-xs font-semibold text-accent-deep">
              Send your first email with it:
            </p>
            <SendSnippets apiKey={minted} />
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

      <Card title="How to send">
        <p className="text-sm text-ink-soft">
          POST Resend-shaped payloads to your send API with any key. Supports templates
          (template_id + variables), attachments (base64), idempotency keys, and scheduling.
        </p>
        <SendSnippets apiKey={null} />
      </Card>
    </div>
  );
}
