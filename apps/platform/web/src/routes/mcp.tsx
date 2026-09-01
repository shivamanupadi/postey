import { lazy, Suspense, useState, type FormEvent, type ReactElement } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button, Dropdown, ErrorNote, Field, Input, Modal, PageHeader } from '@/lib/ui';

const CodeEditor = lazy(() => import('@/lib/code-editor'));

export const Route = createFileRoute('/mcp')({
  component: McpPage,
});

/* ── clients ────────────────────────────────────────────────────── */

type ClientId = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'windsurf' | 'zed';

const CLIENTS: { id: ClientId; label: string; icon: string }[] = [
  { id: 'claude-code', label: 'Claude Code', icon: '/mcp-clients/claude.svg' },
  { id: 'claude-desktop', label: 'Claude Desktop', icon: '/mcp-clients/claude.svg' },
  { id: 'cursor', label: 'Cursor', icon: '/mcp-clients/cursor.svg' },
  { id: 'vscode', label: 'VS Code', icon: '/mcp-clients/vscode.svg' },
  { id: 'windsurf', label: 'Windsurf', icon: '/mcp-clients/windsurf.svg' },
  { id: 'zed', label: 'Zed', icon: '/mcp-clients/zed.svg' },
];

const TOOLS: { name: string; desc: string }[] = [
  { name: 'send_email', desc: 'send through any active domain' },
  { name: 'get_email', desc: 'delivery status + recipients' },
  { name: 'list_emails', desc: 'recent sends, filterable' },
  { name: 'list_replies', desc: 'inbound mail, threaded to its send' },
  { name: 'get_reply', desc: 'full inbound message content' },
  { name: 'reply_to', desc: 'answer as the receiving address' },
  { name: 'list_templates', desc: 'available templates + variables' },
  { name: 'create_template', desc: 'save a reusable template' },
  { name: 'suppress_address', desc: 'block an address' },
  { name: 'list_suppressions', desc: 'search the suppression list' },
];

/** JSON-based clients embed the URL/key in a config file; mcp-remote bridges
 *  clients that only launch stdio servers. */
function buildConfig(
  client: ClientId,
  mcpUrl: string,
  key: string
): { title: string; snippet: string; lang: 'shell' | 'javascript'; hint: string } {
  const jsonHeaders = `"headers": { "Authorization": "Bearer ${key}" }`;
  switch (client) {
    case 'claude-code':
      return {
        title: 'Add Postey to Claude Code',
        lang: 'shell',
        snippet: `claude mcp add --transport http postey ${mcpUrl} \\
  --header "Authorization: Bearer ${key}"`,
        hint: 'Run once in any project, then ask Claude Code to "send a test email with postey".',
      };
    case 'claude-desktop':
      return {
        title: 'Add Postey to Claude Desktop',
        lang: 'javascript',
        snippet: `{
  "mcpServers": {
    "postey": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "${mcpUrl}",
        "--header", "Authorization: Bearer ${key}"
      ]
    }
  }
}`,
        hint: 'Settings → Developer → Edit Config (claude_desktop_config.json), then restart the app.',
      };
    case 'cursor':
      return {
        title: 'Add Postey to Cursor',
        lang: 'javascript',
        snippet: `{
  "mcpServers": {
    "postey": {
      "url": "${mcpUrl}",
      ${jsonHeaders}
    }
  }
}`,
        hint: 'Add to .cursor/mcp.json in your project (or ~/.cursor/mcp.json for everywhere), then reload.',
      };
    case 'vscode':
      return {
        title: 'Add Postey to VS Code',
        lang: 'javascript',
        snippet: `{
  "servers": {
    "postey": {
      "type": "http",
      "url": "${mcpUrl}",
      ${jsonHeaders}
    }
  }
}`,
        hint: 'Add to .vscode/mcp.json, then start the server from the Extensions → MCP Servers view.',
      };
    case 'windsurf':
      return {
        title: 'Add Postey to Windsurf',
        lang: 'javascript',
        snippet: `{
  "mcpServers": {
    "postey": {
      "serverUrl": "${mcpUrl}",
      ${jsonHeaders}
    }
  }
}`,
        hint: 'Add to ~/.codeium/windsurf/mcp_config.json, then refresh plugins in Cascade.',
      };
    case 'zed':
      return {
        title: 'Add Postey to Zed',
        lang: 'javascript',
        snippet: `{
  "context_servers": {
    "postey": {
      "command": {
        "path": "npx",
        "args": [
          "-y", "mcp-remote", "${mcpUrl}",
          "--header", "Authorization: Bearer ${key}"
        ]
      }
    }
  }
}`,
        hint: 'Add to Zed settings.json (cmd-, ), then check the server under Agent Panel settings.',
      };
  }
}

/* ── small pieces ───────────────────────────────────────────────── */

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${
        copied
          ? 'bg-accent-soft text-accent-deep'
          : 'border border-line text-ink-soft hover:bg-card hover:text-ink'
      }`}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

function StepNumber({ n, done }: { n: number; done: boolean }): ReactElement {
  return (
    <span
      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs font-bold ${
        done ? 'bg-accent text-white' : 'bg-accent-soft text-accent-deep'
      }`}
    >
      {done ? '✓' : n}
    </span>
  );
}

/* ── page ───────────────────────────────────────────────────────── */

interface KeyRow {
  id: string;
  name: string;
  key_prefix: string;
  domain_name: string | null;
  revoked_at: number | null;
}

function McpPage(): ReactElement {
  const qc = useQueryClient();
  const config = useQuery({
    queryKey: ['instance-config'],
    queryFn: async () => {
      const res = await fetch('/api/config');
      return (await res.json()) as { sendUrl: string | null };
    },
    staleTime: Infinity,
  });
  const keys = useQuery({ queryKey: ['keys'], queryFn: () => api.get<KeyRow[]>('/api/keys') });
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string; status: string }[]>('/api/domains'),
  });

  const [client, setClient] = useState<ClientId>('claude-code');
  const [keyId, setKeyId] = useState('');
  /** Full token of a key minted on this page - the only time a real key can
   *  be embedded in the snippet (stored keys are hashed, prefix-only). */
  const [minted, setMinted] = useState<{ id: string; key: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [domainId, setDomainId] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; key: string }>('/api/keys', {
        name,
        ...(domainId ? { domain_id: domainId } : {}),
      }),
    onSuccess: data => {
      setMinted({ id: data.id, key: data.key });
      setKeyId(data.id);
      setCreating(false);
      setName('');
      setDomainId('');
      qc.invalidateQueries({ queryKey: ['keys'] });
    },
  });
  const submitCreate = (e: FormEvent): void => {
    e.preventDefault();
    if (name) create.mutate();
  };

  const sendUrl = config.data?.sendUrl ?? 'https://<your-send-worker>';
  const mcpUrl = `${sendUrl}/api/mcp`;
  const activeKeys = keys.data?.filter(k => !k.revoked_at) ?? [];
  const selected = activeKeys.find(k => k.id === keyId);
  const keyDone = Boolean(minted || selected);
  const snippetKey = minted
    ? minted.key
    : selected
      ? `${selected.key_prefix}…  ⟵ paste the full key`
      : '<YOUR_API_KEY>';
  const cfg = buildConfig(client, mcpUrl, snippetKey);
  const scopable = domains.data?.filter(d => d.status !== 'archived');

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="MCP server"
        sub="Give Claude and other agents their own email tools - send, look up delivery status, manage templates and suppressions."
      />

      {/* endpoint - always visible, independent of the steps below */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line-soft bg-card p-5 shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
        <div className="min-w-0 flex-1">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
            Your MCP endpoint
          </span>
          <div className="flex items-center gap-2.5">
            <code className="min-w-0 flex-1 truncate rounded-[10px] border border-line bg-paper px-3.5 py-2.5 font-mono text-[12.5px]">
              {mcpUrl}
            </code>
            <CopyButton text={mcpUrl} />
          </div>
        </div>
        <div className="text-right">
          <span className="inline-block rounded-full bg-ok-soft px-2.5 py-0.5 text-[11.5px] font-bold text-ok">
            {TOOLS.length} tools available
          </span>
          <p className="mt-1.5 text-[11.5px] text-ink-soft">Streamable HTTP · Bearer-key auth</p>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[7fr_5fr]">
        {/* guided setup */}
        <div className="rounded-2xl border border-line-soft bg-card p-6 shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
          <h2 className="mb-5 text-[15px] font-semibold text-ink">Connect a client</h2>

          <div className="grid grid-cols-[30px_1fr] gap-x-3.5">
            <StepNumber n={1} done />
            <div className="relative pb-6 before:absolute before:-left-[27px] before:bottom-1 before:top-[30px] before:w-0.5 before:bg-line-soft">
              <p className="pt-0.5 text-[13.5px] font-semibold">Choose your client</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {CLIENTS.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setClient(c.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      client === c.id
                        ? 'border-accent bg-accent-soft text-accent-deep'
                        : 'border-line bg-card text-ink-soft hover:bg-paper hover:text-ink'
                    }`}
                  >
                    <img src={c.icon} alt="" className="h-3.5 w-3.5" />
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <StepNumber n={2} done={keyDone} />
            <div className="relative pb-6 before:absolute before:-left-[27px] before:bottom-1 before:top-[30px] before:w-0.5 before:bg-line-soft">
              <p className="pt-0.5 text-[13.5px] font-semibold">Pick an API key</p>
              <div className="mt-2 flex items-center gap-2.5">
                <div className="flex-1">
                  <Dropdown
                    full
                    value={keyId}
                    onChange={id => {
                      setKeyId(id);
                      if (minted && id !== minted.id) setMinted(null);
                    }}
                    options={[
                      { value: '', label: 'Select a key…' },
                      ...activeKeys.map(k => ({
                        value: k.id,
                        label: `${k.key_prefix}… · ${k.name}`,
                      })),
                    ]}
                  />
                </div>
                <Button variant="ghost" onClick={() => setCreating(true)}>
                  + Create key
                </Button>
              </div>
              {!minted && (
                <p className="mt-2 text-xs leading-relaxed text-ink-soft">
                  Stored keys are hashed, so an existing key leaves a blank to fill in. Create a
                  key here to get a paste-ready config.
                </p>
              )}
              {minted && (
                <p className="mt-2 text-xs font-medium text-accent-deep">
                  New key is filled into the config below - it is shown only until you leave this
                  page.
                </p>
              )}
            </div>

            <StepNumber n={3} done={false} />
            <div>
              <div className="flex items-center justify-between pt-0.5">
                <p className="text-[13.5px] font-semibold">{cfg.title}</p>
                <CopyButton text={cfg.snippet} />
              </div>
              <div className="mt-2 overflow-hidden rounded-xl border border-line">
                <Suspense
                  fallback={
                    <div className="flex h-[180px] items-center justify-center bg-card text-xs text-ink-soft">
                      Loading…
                    </div>
                  }
                >
                  <CodeEditor value={cfg.snippet} lang={cfg.lang} readOnly height="auto" />
                </Suspense>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-soft">{cfg.hint}</p>
            </div>
          </div>
        </div>

        {/* tools reference */}
        <div className="rounded-2xl border border-line-soft bg-card p-6 shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-ink">Tools</h2>
            <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-[11.5px] font-bold text-ok">
              {TOOLS.length}
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
            What a connected agent can do, scoped by the key it authenticates with.
          </p>
          <div className="mt-3">
            {TOOLS.map((t, i) => (
              <div
                key={t.name}
                className={`flex items-baseline gap-2.5 py-2 ${i ? 'border-t border-line-soft' : ''}`}
              >
                <code className="font-mono text-xs font-semibold text-ink">{t.name}</code>
                <span className="text-xs text-ink-soft">{t.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {creating && (
        <Modal
          title="Create an API key"
          sub="Shown once, then only its prefix."
          onClose={() => {
            setCreating(false);
            create.reset();
          }}
        >
          <form onSubmit={submitCreate} className="mt-4 space-y-4">
            <Field label="Name">
              <Input
                autoFocus
                placeholder={`mcp-${client}`}
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </Field>
            <Field label="Scope">
              <Dropdown
                full
                value={domainId}
                onChange={setDomainId}
                options={[
                  { value: '', label: 'All domains' },
                  ...(scopable ?? []).map(d => ({ value: d.id, label: d.name })),
                ]}
              />
            </Field>
            <p className="text-xs leading-relaxed text-ink-soft">
              The new key drops straight into step 2 and the config snippet. A scoped key can only
              send from its domain.
            </p>
            <ErrorNote error={create.error} />
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  setCreating(false);
                  create.reset();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name}>
                {create.isPending ? 'Creating…' : 'Create key'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
