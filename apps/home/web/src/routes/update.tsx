import { useEffect, useState, type ReactElement } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  ConnectPanel,
  ErrorNote,
  Panel,
  PrimaryButton,
  readSse,
  StepList,
  wizardApi,
  type Account,
  type Install,
  type ResumeState,
  type StepEvent,
} from '../deploy/shared';

export const Route = createFileRoute('/update')({
  component: UpdateWizard,
  validateSearch: (s: Record<string, unknown>): { instance?: string } =>
    typeof s.instance === 'string' ? { instance: s.instance } : {},
});

type Screen = 'loading' | 'connect' | 'ready' | 'progress' | 'done' | 'no-session';

function UpdateWizard(): ReactElement {
  const { instance } = Route.useSearch();
  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState<string | null>(null);
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const [state, setState] = useState<ResumeState | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [apiToken, setApiToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [result, setResult] = useState<{ apiUrl: string; claimCode?: string } | null>(null);

  useEffect(() => {
    void fetch('/api/config')
      .then(r => r.json() as Promise<{ oauthEnabled?: boolean }>)
      .then(cfg => setOauthEnabled(Boolean(cfg.oauthEnabled)))
      .catch(() => undefined);
    void fetch('/api/deploy/latest-version')
      .then(r => r.json() as Promise<{ data?: { version?: string } }>)
      .then(d => setLatest(d.data?.version ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!instance) {
      setScreen('no-session');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const s = await wizardApi<ResumeState>(`/instance/${instance}`);
        if (cancelled) return;
        if (!s.instanceName || !s.sendingDomain) {
          setScreen('no-session');
          return;
        }
        setState(s);
        setScreen('connect');
        const token = new URLSearchParams(window.location.hash.slice(1)).get('cf_token');
        const oerr = new URLSearchParams(window.location.search).get('oauth_error');
        if (oerr) setError(`Cloudflare sign-in failed: ${oerr}`);
        if (token) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          setApiToken(token);
          void connect(token, s);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'failed to load session');
          setScreen('no-session');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);

  async function connect(token?: string, loaded?: ResumeState): Promise<void> {
    const useToken = token ?? apiToken;
    const s = loaded ?? state;
    setError(null);
    try {
      const res = await fetch(`/api/deploy/instance/${instance}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: useToken }),
      });
      const data = (await res.json()) as { data?: Account[]; installs?: Install[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'token check failed');
      const list = data.data ?? [];
      setAccounts(list);
      // Prefer the account that owns this instance, else the only account.
      const owning = (data.installs ?? []).find(i => i.instance_name === s?.instanceName);
      setAccountId(owning?.account_id ?? (list.length === 1 ? list[0].id : ''));
      setScreen('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'token check failed');
    }
  }

  async function runUpdate(): Promise<void> {
    if (!state?.sendingDomain || !state.instanceName) return;
    setError(null);
    setSteps([]);
    setScreen('progress');
    try {
      const res = await fetch(`/api/deploy/instance/${instance}/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken,
          accountId,
          instanceName: state.instanceName,
          sendingDomain: state.sendingDomain,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `update failed (${res.status})`);
      }
      await readSse(res, payload => {
        if (payload.type === 'step') setSteps(prev => [...prev, payload as unknown as StepEvent]);
        else if (payload.type === 'done') {
          setResult(payload as unknown as { apiUrl: string; claimCode?: string });
          setScreen('done');
        } else if (payload.type === 'error') setError(String(payload.message));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'update failed');
    }
  }

  const domain = state?.sendingDomain
    ? state.sendingDomain.subdomain
      ? `${state.sendingDomain.subdomain}.${state.sendingDomain.zoneName}`
      : state.sendingDomain.zoneName
    : '';

  return (
    <main className="mx-auto max-w-2xl px-5 py-14">
      <h1 className="font-display text-3xl font-semibold text-ink">Update Postey</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Re-provisions your instance from the latest release. Updates are idempotent and in-place:
        your data, keys, and settings are untouched, and a failed update leaves the running
        version serving.
      </p>

      <div className="mt-8 space-y-6">
        {screen === 'loading' && <p className="text-sm text-ink-soft">Loading session…</p>}

        {screen === 'no-session' && (
          <Panel title="No instance session">
            <p className="text-sm leading-relaxed text-ink-soft">
              Open this page from your deploy link (postey.app/deploy?instance=…) - the same id
              works here: <code className="font-mono">/update?instance=&lt;id&gt;</code>.
            </p>
            <ErrorNote error={error} />
          </Panel>
        )}

        {screen === 'connect' && (
          <>
            <Panel title={`Instance · ${state?.instanceName ?? ''}`}>
              <dl className="space-y-1 text-sm text-ink-soft">
                <div>
                  Sending domain: <span className="font-mono text-ink">{domain}</span>
                </div>
                <div>
                  Installed version:{' '}
                  <span className="font-mono text-ink">{state?.deployedVersion ?? 'unknown'}</span>
                  {latest && (
                    <>
                      {' '}
                      → latest <span className="font-mono text-accent">{latest}</span>
                    </>
                  )}
                </div>
              </dl>
            </Panel>
            <ConnectPanel
              instance={instance}
              flow="update"
              oauthEnabled={oauthEnabled}
              apiToken={apiToken}
              setApiToken={setApiToken}
              onContinue={() => void connect()}
              error={error}
            />
          </>
        )}

        {screen === 'ready' && (
          <Panel title="2 · Update">
            {accounts.length > 1 && (
              <label className="mb-4 block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-soft">
                  Account
                </span>
                <select
                  className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm"
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                >
                  <option value="">Pick the account that owns {state?.instanceName}</option>
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="mb-4 text-sm text-ink-soft">
              Updates <span className="font-mono text-ink">{state?.instanceName}</span>
              {latest ? (
                <>
                  {' '}
                  to <span className="font-mono text-accent">v{latest}</span>
                </>
              ) : null}
              . The run resumes safely if interrupted.
            </p>
            <PrimaryButton onClick={() => void runUpdate()} disabled={!accountId}>
              Update instance
            </PrimaryButton>
            <ErrorNote error={error} />
          </Panel>
        )}

        {(screen === 'progress' || screen === 'done') && (
          <Panel title="3 · Updating">
            <StepList steps={steps} />
            {screen === 'progress' && error && (
              <>
                <ErrorNote error={error} />
                <div className="mt-3">
                  <PrimaryButton onClick={() => void runUpdate()}>
                    Retry (resumes where it failed)
                  </PrimaryButton>
                </div>
              </>
            )}
          </Panel>
        )}

        {screen === 'done' && result && (
          <Panel title="✓ Updated">
            <p className="text-sm">
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
              {latest && <span className="ml-2 font-mono text-xs text-ink-soft">v{latest}</span>}
            </p>
          </Panel>
        )}
      </div>
    </main>
  );
}
