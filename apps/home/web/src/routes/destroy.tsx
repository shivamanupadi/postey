import { useEffect, useState, type ReactElement } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  ConnectPanel,
  ErrorNote,
  Panel,
  PrimaryButton,
  readSse,
  StepList,
  TextInput,
  wizardApi,
  type Account,
  type Install,
  type ResumeState,
  type StepEvent,
} from '../deploy/shared';

export const Route = createFileRoute('/destroy')({
  component: DestroyWizard,
  validateSearch: (s: Record<string, unknown>): { instance?: string } =>
    typeof s.instance === 'string' ? { instance: s.instance } : {},
});

type Screen = 'loading' | 'connect' | 'confirm' | 'progress' | 'done' | 'no-session';

function DestroyWizard(): ReactElement {
  const { instance } = Route.useSearch();
  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState<string | null>(null);
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const [state, setState] = useState<ResumeState | null>(null);
  const [apiToken, setApiToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [confirmName, setConfirmName] = useState('');
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [retained, setRetained] = useState<{ bucket: string; reason: string } | null>(null);

  useEffect(() => {
    void fetch('/api/config')
      .then(r => r.json() as Promise<{ oauthEnabled?: boolean }>)
      .then(cfg => setOauthEnabled(Boolean(cfg.oauthEnabled)))
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
        if (!s.instanceName) {
          setScreen('no-session');
          return;
        }
        setState(s);
        setScreen(s.status === 'destroyed' ? 'done' : 'connect');
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
      const owning = (data.installs ?? []).find(i => i.instance_name === s?.instanceName);
      setAccountId(owning?.account_id ?? (list.length === 1 ? list[0].id : ''));
      setScreen('confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'token check failed');
    }
  }

  async function runDestroy(): Promise<void> {
    if (!state?.instanceName) return;
    setError(null);
    setSteps([]);
    setScreen('progress');
    try {
      const res = await fetch(`/api/deploy/instance/${instance}/destroy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken,
          accountId,
          instanceName: state.instanceName,
          confirmName,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `destroy failed (${res.status})`);
      }
      await readSse(res, payload => {
        if (payload.type === 'step') setSteps(prev => [...prev, payload as unknown as StepEvent]);
        else if (payload.type === 'done') {
          if (payload.retainedBucket) {
            setRetained({
              bucket: String(payload.retainedBucket),
              reason: String(payload.retainedReason ?? ''),
            });
          }
          setScreen('done');
        } else if (payload.type === 'error') setError(String(payload.message));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'destroy failed');
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-14">
      <h1 className="font-display text-3xl font-semibold text-ink">Destroy Postey</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Tears down everything the wizard provisioned: workers, the queue, the database, and the
        bodies bucket. <strong className="text-red-700">This deletes your email history</strong> -
        there is no undo.
      </p>

      <div className="mt-8 space-y-6">
        {screen === 'loading' && <p className="text-sm text-ink-soft">Loading session…</p>}

        {screen === 'no-session' && (
          <Panel title="No instance session">
            <p className="text-sm leading-relaxed text-ink-soft">
              Open this page from your deploy link:{' '}
              <code className="font-mono">/destroy?instance=&lt;id&gt;</code>.
            </p>
            <ErrorNote error={error} />
          </Panel>
        )}

        {screen === 'connect' && (
          <ConnectPanel
            instance={instance}
            flow="destroy"
            oauthEnabled={oauthEnabled}
            apiToken={apiToken}
            setApiToken={setApiToken}
            onContinue={() => void connect()}
            error={error}
          />
        )}

        {screen === 'confirm' && (
          <Panel title="2 · Confirm">
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
            <p className="text-sm text-ink-soft">
              Type <code className="font-mono text-ink">{state?.instanceName}</code> to confirm the
              teardown:
            </p>
            <div className="mt-3 flex gap-3">
              <TextInput
                value={confirmName}
                onChange={e => setConfirmName(e.target.value)}
                placeholder={state?.instanceName ?? ''}
              />
              <PrimaryButton
                danger
                onClick={() => void runDestroy()}
                disabled={!accountId || confirmName !== state?.instanceName}
              >
                Destroy
              </PrimaryButton>
            </div>
            <ErrorNote error={error} />
          </Panel>
        )}

        {(screen === 'progress' || (screen === 'done' && steps.length > 0)) && (
          <Panel title="3 · Tearing down">
            <StepList steps={steps} />
            {screen === 'progress' && error && (
              <>
                <ErrorNote error={error} />
                <div className="mt-3">
                  <PrimaryButton danger onClick={() => void runDestroy()}>
                    Retry teardown
                  </PrimaryButton>
                </div>
              </>
            )}
          </Panel>
        )}

        {screen === 'done' && (
          <Panel title="Instance destroyed">
            <p className="text-sm text-ink-soft">
              All provisioned resources for{' '}
              <code className="font-mono text-ink">{state?.instanceName}</code> have been removed.
            </p>
            {retained && (
              <p className="mt-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-2.5 text-xs text-accent-deep">
                The bucket <code className="font-mono">{retained.bucket}</code> was kept:{' '}
                {retained.reason} It keeps costing R2 storage until removed in the Cloudflare
                dashboard.
              </p>
            )}
          </Panel>
        )}
      </div>
    </main>
  );
}
