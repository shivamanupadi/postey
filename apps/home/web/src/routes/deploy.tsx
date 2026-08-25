import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/deploy')({
  component: DeployWizard,
  validateSearch: (s: Record<string, unknown>): { instance?: string } =>
    typeof s.instance === 'string' ? { instance: s.instance } : {},
});

/* ── types mirrored from the wizard API ─────────────────────────── */

interface StepEvent {
  stepId: string;
  label: string;
  status: 'start' | 'ok' | 'fail' | 'retry';
  detail?: string;
}

interface ResumeState {
  status: 'new' | 'deploying' | 'ready' | 'failed' | 'destroyed';
  instanceName: string | null;
  apiUrl: string | null;
  sendUrl: string | null;
  sendingDomain: { zoneId: string; zoneName: string; subdomain: string } | null;
  error: string | null;
  steps: StepEvent[];
  updatedAt: number;
}

interface Account {
  id: string;
  name: string;
}

interface Install {
  id: string;
  account_id: string;
  instance_name: string;
  api_url: string | null;
}

/** Mirrors RUN_STALE_MS server-side: a quieter 'deploying' row is dead. */
const RUN_STALE_MS = 3 * 60_000;

const TOKEN_PERMISSIONS = [
  'Workers Scripts: Edit',
  'D1: Edit',
  'Workers R2 Storage: Edit',
  'Queues: Edit',
  'Email Sending: Edit',
  'Zone (DNS): Read',
  'Account Settings: Read',
];

/* ── small UI atoms (kept local; the wizard is one page) ─────────── */

function Panel({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="rounded-2xl border border-line bg-paper p-6">
      <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}): ReactElement {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-deep disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-soft/60 focus:border-accent ${props.className ?? ''}`}
    />
  );
}

function ErrorNote({ error }: { error: string | null }): ReactElement | null {
  if (!error) return null;
  return (
    <p className="mt-3 rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-700">
      {error}
    </p>
  );
}

/* ── the wizard ──────────────────────────────────────────────────── */

type Screen = 'loading' | 'token' | 'config' | 'progress' | 'done';

function DeployWizard(): ReactElement {
  const { instance } = Route.useSearch();
  const navigate = Route.useNavigate();

  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState<string | null>(null);
  const [oauthEnabled, setOauthEnabled] = useState(false);

  const [apiToken, setApiToken] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [installs, setInstalls] = useState<Install[]>([]);
  const [accountId, setAccountId] = useState('');
  const [zones, setZones] = useState<Account[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [subdomain, setSubdomain] = useState('mail');
  const [instanceName, setInstanceName] = useState('postey');

  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [result, setResult] = useState<{ apiUrl: string; sendUrl: string; claimCode?: string } | null>(
    null
  );
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const api = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const res = await fetch(`/api/deploy${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json()) as { data?: T; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      return data.data as T;
    },
    []
  );

  /* Session bootstrap: create one, or resume ?instance=. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!instance) {
          const created = await api<{ id: string }>('/instance', {});
          if (!cancelled) navigate({ search: { instance: created.id }, replace: true });
          return;
        }
        const state = await api<ResumeState>(`/instance/${instance}`);
        if (cancelled) return;
        if (state.instanceName) setInstanceName(state.instanceName);
        if (state.sendingDomain) {
          setZoneId(state.sendingDomain.zoneId);
          setSubdomain(state.sendingDomain.subdomain);
        }
        if (state.status === 'ready' && state.apiUrl) {
          setResult({ apiUrl: state.apiUrl, sendUrl: state.sendUrl ?? '' });
          setSteps(state.steps ?? []);
          setScreen('done');
        } else if (state.status === 'deploying' && state.updatedAt > Date.now() - RUN_STALE_MS) {
          setSteps(state.steps ?? []);
          setScreen('progress');
          startPolling(instance);
        } else {
          setSteps(state.steps ?? []);
          setError(state.error);
          setScreen('token');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'failed to start');
          setScreen('token');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);

  useEffect(() => () => stopPolling(), []);

  /* Wizard bootstrap config + OAuth return. The access token arrives in the
   * URL fragment (never sent to our server); strip it immediately. */
  useEffect(() => {
    void fetch('/api/config')
      .then(r => r.json() as Promise<{ oauthEnabled?: boolean }>)
      .then(cfg => setOauthEnabled(Boolean(cfg.oauthEnabled)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!instance) return;
    const oerr = new URLSearchParams(window.location.search).get('oauth_error');
    if (oerr) setError(`Cloudflare sign-in failed: ${oerr}`);
    const token = new URLSearchParams(window.location.hash.slice(1)).get('cf_token');
    if (token) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setApiToken(token);
      void submitToken(token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);

  function stopPolling(): void {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }

  /** Reattach to a run whose SSE stream we do not own: poll the registry row. */
  function startPolling(id: string): void {
    stopPolling();
    pollTimer.current = setInterval(async () => {
      try {
        const state = await api<ResumeState>(`/instance/${id}`);
        setSteps(state.steps ?? []);
        if (state.status === 'ready' && state.apiUrl) {
          stopPolling();
          setResult({ apiUrl: state.apiUrl, sendUrl: state.sendUrl ?? '' });
          setScreen('done');
        } else if (state.status === 'failed' || state.error) {
          stopPolling();
          setError(state.error ?? 'deploy failed');
          setScreen('progress');
        }
      } catch {
        /* transient - keep polling */
      }
    }, 4000);
  }

  async function submitToken(token?: string): Promise<void> {
    const useToken = token ?? apiToken;
    setError(null);
    try {
      const res = await fetch(`/api/deploy/instance/${instance}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: useToken }),
      });
      const data = (await res.json()) as {
        data?: Account[];
        installs?: Install[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? 'token check failed');
      setAccounts(data.data ?? []);
      setInstalls(data.installs ?? []);
      const first = data.data?.[0];
      if (first) {
        setAccountId(first.id);
        await loadZones(first.id, useToken);
      }
      setScreen('config');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'token check failed');
    }
  }

  async function loadZones(acct: string, token?: string): Promise<void> {
    try {
      const list = await api<Account[]>(`/instance/${instance}/zones`, {
        apiToken: token ?? apiToken,
        accountId: acct,
      });
      setZones(list);
      if (list[0]) setZoneId(prev => (list.some(zn => zn.id === prev) ? prev : list[0].id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'zone list failed');
    }
  }

  async function provision(): Promise<void> {
    setError(null);
    setSteps([]);
    setScreen('progress');
    const zone = zones.find(zn => zn.id === zoneId);
    if (!zone) {
      setError('Pick a zone');
      return;
    }
    try {
      const res = await fetch(`/api/deploy/instance/${instance}/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken,
          accountId,
          instanceName,
          sendingDomain: { zoneId: zone.id, zoneName: zone.name, subdomain },
        }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `provision failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const raw of events) {
          const line = raw.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6)) as
            | ({ type: 'step' } & StepEvent)
            | { type: 'done'; apiUrl: string; sendUrl: string; claimCode?: string }
            | { type: 'error'; message: string };
          if (payload.type === 'step') {
            setSteps(prev => [...prev, payload]);
          } else if (payload.type === 'done') {
            setResult(payload);
            setScreen('done');
          } else if (payload.type === 'error') {
            setError(payload.message);
          }
        }
      }
      // Stream ended without done/error (tab hiccup, proxy timeout): reattach.
      setScreen(current => {
        if (current === 'progress' && instance) startPolling(instance);
        return current;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'provision failed');
      if (instance) startPolling(instance);
    }
  }

  /* Collapse the raw event log into one row per step (latest status wins). */
  const stepRows: StepEvent[] = [];
  for (const ev of steps) {
    const existing = stepRows.findIndex(s => s.stepId === ev.stepId);
    if (existing >= 0) stepRows[existing] = ev;
    else stepRows.push(ev);
  }
  const onboardWaiting = stepRows.some(s => s.stepId === 'onboard' && s.status === 'retry');

  return (
    <main className="mx-auto max-w-2xl px-5 py-14">
      <h1 className="font-display text-3xl font-semibold text-ink">Deploy Postey</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Provisions a complete Postey instance into <em>your</em> Cloudflare account: three workers,
        a D1 database, an R2 bucket, and a queue. Your token is used for this run only - never
        stored. Resume anytime with this page's URL.
      </p>

      <div className="mt-8 space-y-6">
        {screen === 'loading' && <p className="text-sm text-ink-soft">Starting a session…</p>}

        {screen === 'token' && (
          <Panel title="1 · Connect Cloudflare">
            {oauthEnabled && (
              <div className="mb-5">
                <a
                  href={`/api/deploy/oauth/start?instance=${encodeURIComponent(instance ?? '')}`}
                  className="inline-block rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-deep"
                >
                  Sign in with Cloudflare →
                </a>
                <p className="mt-2 text-xs text-ink-soft">
                  One click: authorize on the Cloudflare dashboard and come straight back. Or paste
                  an API token below.
                </p>
                <div className="mt-4 border-t border-line" />
              </div>
            )}
            <p className="text-sm leading-relaxed text-ink-soft">
              Create an API token in the Cloudflare dashboard (
              <a
                className="text-accent underline"
                href="https://dash.cloudflare.com/profile/api-tokens"
                target="_blank"
                rel="noreferrer"
              >
                My Profile → API Tokens
              </a>
              ) with these permissions:
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-1 text-xs text-ink-soft">
              {TOKEN_PERMISSIONS.map(p => (
                <li key={p} className="font-mono">
                  · {p}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex gap-3">
              <TextInput
                type="password"
                placeholder="Cloudflare API token"
                value={apiToken}
                onChange={e => setApiToken(e.target.value)}
              />
              <PrimaryButton onClick={submitToken} disabled={apiToken.length < 20}>
                Continue
              </PrimaryButton>
            </div>
            <p className="mt-3 text-xs text-ink-soft">
              Requires the <strong>Workers Paid</strong> plan ($5/mo) - Queues and Email Sending are
              not available on the free plan.
            </p>
            <ErrorNote error={error} />
          </Panel>
        )}

        {screen === 'config' && (
          <Panel title="2 · Configure the instance">
            {installs.length > 0 && (
              <p className="mb-4 rounded-xl border border-accent/40 bg-accent-soft px-4 py-2.5 text-xs text-accent-deep">
                This account already has {installs.length} Postey install
                {installs.length > 1 ? 's' : ''} ({installs.map(i => i.instance_name).join(', ')}).
                Re-deploying with the same instance name updates it in place.
              </p>
            )}
            <div className="space-y-4">
              {accounts.length > 1 && (
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft">
                    Account
                  </span>
                  <select
                    className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm"
                    value={accountId}
                    onChange={e => {
                      setAccountId(e.target.value);
                      void loadZones(e.target.value);
                    }}
                  >
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft">
                  Instance name (prefixes every resource)
                </span>
                <TextInput
                  value={instanceName}
                  onChange={e => setInstanceName(e.target.value)}
                  placeholder="postey"
                />
              </label>
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft">
                    Zone
                  </span>
                  <select
                    className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm"
                    value={zoneId}
                    onChange={e => setZoneId(e.target.value)}
                  >
                    {zones.map(zn => (
                      <option key={zn.id} value={zn.id}>
                        {zn.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft">
                    Email sending subdomain
                  </span>
                  <TextInput
                    value={subdomain}
                    onChange={e => setSubdomain(e.target.value)}
                    placeholder="mail (empty = apex)"
                  />
                </label>
              </div>
              <p className="text-xs text-ink-soft">
                This only sets the From-domain of your emails: you'll send from{' '}
                <code className="font-mono text-ink">
                  anything@
                  {subdomain ? `${subdomain}.` : ''}
                  {zones.find(zn => zn.id === zoneId)?.name ?? 'example.com'}
                </code>
                . A subdomain keeps your root domain's mail reputation separate - recommended. The
                app itself deploys to workers.dev URLs, not here.
              </p>
              <PrimaryButton onClick={provision} disabled={!zoneId || !instanceName}>
                Deploy to Cloudflare
              </PrimaryButton>
            </div>
            <ErrorNote error={error} />
          </Panel>
        )}

        {(screen === 'progress' || (screen === 'done' && stepRows.length > 0)) && (
          <Panel title="3 · Provisioning">
            <ol className="space-y-2">
              {stepRows.map(s => (
                <li key={s.stepId} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 w-5 text-center">
                    {s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : '·'}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={
                        s.status === 'fail'
                          ? 'font-medium text-red-700'
                          : s.status === 'ok'
                            ? 'text-ink'
                            : 'font-medium text-ink'
                      }
                    >
                      {s.label}
                      {s.status === 'start' || s.status === 'retry' ? '…' : ''}
                    </p>
                    {s.detail && <p className="mt-0.5 break-words text-xs text-ink-soft">{s.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
            {onboardWaiting && screen === 'progress' && (
              <div className="mt-5 rounded-xl border border-accent/40 bg-accent-soft p-4">
                <p className="text-sm font-semibold text-accent-deep">One manual step (two clicks)</p>
                <p className="mt-1 text-xs leading-relaxed text-accent-deep/80">
                  Cloudflare has no public API for Email Sending onboarding yet. Open the dashboard,
                  select <strong>Onboard Domain</strong>, pick your sending domain, and select{' '}
                  <strong>Done</strong>. All DNS records are created automatically; detection here is
                  automatic too.
                </p>
                <a
                  href="https://dash.cloudflare.com/?to=/:account/email-service/sending"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block rounded-full bg-accent px-5 py-2 text-xs font-semibold text-white hover:bg-accent-deep"
                >
                  Open Email Sending in the dashboard →
                </a>
              </div>
            )}
            {screen === 'progress' && error && (
              <>
                <ErrorNote error={error} />
                <div className="mt-3">
                  <PrimaryButton onClick={provision}>Retry (resumes where it failed)</PrimaryButton>
                </div>
              </>
            )}
          </Panel>
        )}

        {screen === 'done' && result && (
          <Panel title="🎉 Your instance is live">
            <div className="space-y-4 text-sm">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                  Dashboard
                </p>
                <a
                  className="font-mono text-accent underline"
                  href={
                    result.claimCode
                      ? `${result.apiUrl}/login#claim=${result.claimCode}`
                      : result.apiUrl
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {result.apiUrl}
                </a>
                {result.claimCode && (
                  <p className="mt-1 text-xs text-ink-soft">
                    This link carries your one-time claim code - open it now to create the operator
                    account. The code is not stored anywhere else.
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                  Send API
                </p>
                <code className="font-mono text-xs">{result.sendUrl}/api/emails</code>
                <p className="mt-1 text-xs text-ink-soft">
                  Create an API key in the dashboard, then POST Resend-shaped payloads here.
                </p>
              </div>
              <p className="text-xs text-ink-soft">
                Bookmark this page's URL - it is the handle for{' '}
                <a className="text-accent underline" href={`/update?instance=${instance ?? ''}`}>
                  updating
                </a>{' '}
                and{' '}
                <a className="text-accent underline" href={`/destroy?instance=${instance ?? ''}`}>
                  destroying
                </a>{' '}
                this instance later.
              </p>
            </div>
          </Panel>
        )}
      </div>
    </main>
  );
}
