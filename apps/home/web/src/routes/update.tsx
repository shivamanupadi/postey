import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowRight, Check, Loader2 } from 'lucide-react';
import {
  BackButton,
  Card,
  CardTitle,
  collapseSteps,
  ConnectSection,
  CopyField,
  ErrorBox,
  PrimaryButton,
  PROVISION_PLAN,
  readSse,
  useConnect,
  WizardShell,
  wizardApi,
  type ResumeState,
  type StepEvent,
} from '../deploy/shared';

export const Route = createFileRoute('/update')({
  component: UpdateWizard,
  validateSearch: (s: Record<string, unknown>): { instance?: string } =>
    typeof s.instance === 'string' ? { instance: s.instance } : {},
});

type Phase = 'loading' | 'no-session' | 'connect' | 'review' | 'updating' | 'done';

const PHASE_INDEX: Record<Phase, number> = {
  loading: 0,
  'no-session': 0,
  connect: 0,
  review: 1,
  updating: 2,
  done: 2,
};

/* ── split shell: rail (instance + plan) | phase panel ──────────── */

function SplitShell({ rail, children }: { rail: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div className="mx-auto grid w-full max-w-[900px] overflow-hidden rounded-[20px] border border-line-soft bg-white shadow-[0_12px_40px_-16px_rgba(30,25,18,0.18)] md:grid-cols-[330px_1fr]">
      <aside className="border-b border-line-soft bg-paper px-6 py-6 md:border-b-0 md:border-r">
        {rail}
      </aside>
      <div className="flex min-h-[440px] flex-col p-7">{children}</div>
    </div>
  );
}

function VersionArrow({ from, to }: { from: string | null; to: string | null }): ReactElement {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[12px]">
      <span className="rounded-md bg-paper-deep px-2 py-0.5 text-ink-soft">v{from ?? '?'}</span>
      <span className="text-accent">→</span>
      <span className="rounded-md bg-accent-soft px-2 py-0.5 font-semibold text-accent-deep">
        v{to ?? '?'}
      </span>
    </span>
  );
}

type RailRow = { stepId: string; label: string; status: StepEvent['status'] | 'pending' };

function railRows(steps: StepEvent[]): RailRow[] {
  const byId = new Map(collapseSteps(steps).map(s => [s.stepId, s]));
  const rows: RailRow[] = PROVISION_PLAN.map(p => {
    const ev = byId.get(p.stepId);
    return { stepId: p.stepId, label: p.label, status: ev?.status ?? 'pending' };
  });
  for (const ev of collapseSteps(steps)) {
    if (!rows.some(r => r.stepId === ev.stepId)) {
      rows.push({ stepId: ev.stepId, label: ev.label, status: ev.status });
    }
  }
  return rows;
}

function RailStepIcon({ status }: { status: RailRow['status'] }): ReactElement {
  if (status === 'ok')
    return (
      <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full bg-emerald-100">
        <Check className="h-2.5 w-2.5 text-emerald-700" strokeWidth={3} />
      </span>
    );
  if (status === 'fail')
    return <span className="h-[15px] w-[15px] shrink-0 rounded-full bg-red-100 ring-1 ring-red-300" />;
  if (status === 'start' || status === 'retry')
    return <Loader2 className="h-[15px] w-[15px] shrink-0 animate-spin text-accent" />;
  return <span className="h-[15px] w-[15px] shrink-0 rounded-full border-[1.5px] border-line" />;
}

/** The rail: instance identity + the always-visible 14-step plan. */
function Rail({
  state,
  latest,
  upToDate,
  steps,
  running,
  finished,
  elapsed,
  domain,
}: {
  state: ResumeState | null;
  latest: string | null;
  upToDate: boolean;
  steps: StepEvent[];
  running: boolean;
  finished: boolean;
  elapsed: number;
  domain: string;
}): ReactElement {
  const rows = railRows(steps);
  const done = rows.filter(r => r.status === 'ok').length;
  const started = running || finished;
  return (
    <div>
      <div className="mb-4 border-b border-line-soft pb-4">
        <p className="font-mono text-[13.5px] font-bold text-ink">{state?.instanceName}</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink-soft">{domain}</p>
        <div className="mt-2.5">
          {upToDate && !started ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-ink">
              v{state?.deployedVersion}
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                latest
              </span>
            </span>
          ) : (
            <VersionArrow
              from={state?.deployedVersion ?? null}
              to={latest}
            />
          )}
        </div>
        {!started && !upToDate && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-ink-soft">
            current version as recorded at your last update
          </p>
        )}
      </div>
      {started ? (
        <div className="mb-3">
          <p className="text-[11px] font-semibold text-ink-soft">
            {done} of {rows.length} steps
            {elapsed > 0 && <span className="font-normal"> · {elapsed}s</span>}
          </p>
          <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-paper-deep">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${finished ? 'bg-emerald-600' : 'bg-accent'}`}
              style={{ width: `${Math.round((done / Math.max(rows.length, 1)) * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-soft">
          Update plan · {rows.length} steps
        </p>
      )}
      <div>
        {rows.map(r => (
          <div
            key={r.stepId}
            className={`flex items-center gap-2.5 py-[3px] text-[12px] ${
              r.status === 'pending'
                ? 'text-ink-soft/55'
                : r.status === 'ok'
                  ? 'text-ink-soft'
                  : r.status === 'fail'
                    ? 'font-semibold text-red-700'
                    : 'font-semibold text-ink'
            }`}
          >
            <RailStepIcon status={r.status} />
            <span className="min-w-0 truncate">{r.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── flight check ───────────────────────────────────────────────── */

function FlightCheck(): ReactElement {
  const li = 'flex gap-2 py-[3px] leading-snug';
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className="rounded-2xl bg-accent-soft px-4 py-3.5 text-[12px] text-[#5c2531]">
        <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[0.08em] text-accent-deep">
          This update
        </p>
        <p className={li}>
          <span className="font-bold text-accent-deep">→</span>Redeploys the send, inbound, and
          dashboard workers
        </p>
        <p className={li}>
          <span className="font-bold text-accent-deep">→</span>Applies any pending database
          migrations
        </p>
        <p className={li}>
          <span className="font-bold text-accent-deep">→</span>Refreshes dashboard assets
        </p>
      </div>
      <div className="rounded-2xl bg-emerald-50 px-4 py-3.5 text-[12px] text-[#1d4231]">
        <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[0.08em] text-emerald-700">
          Untouched
        </p>
        <p className={li}>
          <span className="font-extrabold text-emerald-700">✓</span>Emails, logs, and suppressions
        </p>
        <p className={li}>
          <span className="font-extrabold text-emerald-700">✓</span>API keys and templates
        </p>
        <p className={li}>
          <span className="font-extrabold text-emerald-700">✓</span>Domains and DNS
        </p>
      </div>
    </div>
  );
}

/* ── wizard ─────────────────────────────────────────────────────── */

function UpdateWizard(): ReactElement {
  const { instance: sessionId } = Route.useSearch();
  const navigate = useNavigate();
  const connect = useConnect('update', sessionId);

  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<ResumeState | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [result, setResult] = useState<{ apiUrl: string; claimCode?: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    void wizardApi<{ version?: string }>('/latest-version')
      .then(d => setLatest(d.version ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (connect.oauthError) setError(connect.oauthError);
  }, [connect.oauthError]);

  // Once the account is verified, land on review with the owning account picked.
  useEffect(() => {
    if (phase !== 'connect' || connect.tokenStatus !== 'ok') return;
    const owning = connect.installs.find(i => i.instance_name === state?.instanceName);
    if (owning) connect.setAccountId(owning.account_id);
    setPhase('review');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect.tokenStatus, phase]);

  useEffect(() => {
    if (!sessionId) {
      setPhase('no-session');
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const s = await wizardApi<ResumeState>(`/instance/${sessionId}`);
        if (!s.instanceName || !s.sendingDomain) {
          setPhase('no-session');
          return;
        }
        setState(s);
        setPhase('connect');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load session');
        setPhase('no-session');
      }
    })();
  }, [sessionId]);

  // Elapsed ticker while the run is live.
  useEffect(() => {
    if (phase !== 'updating') return;
    const startedAt = Date.now() - elapsed * 1000;
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const runUpdate = async (): Promise<void> => {
    if (!state?.sendingDomain || !state.instanceName) return;
    setBusy(true);
    setError('');
    setSteps([]);
    setElapsed(0);
    setPhase('updating');
    try {
      const res = await fetch(`/api/deploy/instance/${sessionId}/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken: connect.token.trim(),
          accountId: connect.accountId,
          instanceName: state.instanceName,
          sendingDomain: state.sendingDomain,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `update failed (${res.status})`);
      }
      await readSse(res, payload => {
        if (payload.type === 'step') setSteps(prev => [...prev, payload as unknown as StepEvent]);
        else if (payload.type === 'done') {
          setResult(payload as unknown as { apiUrl: string; claimCode?: string });
          setPhase('done');
        } else if (payload.type === 'error') setError(String(payload.message));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'update failed');
    } finally {
      setBusy(false);
    }
  };

  const domain = state?.sendingDomain
    ? state.sendingDomain.subdomain
      ? `${state.sendingDomain.subdomain}.${state.sendingDomain.zoneName}`
      : state.sendingDomain.zoneName
    : '';
  const upToDate = Boolean(latest && state?.deployedVersion && latest === state.deployedVersion);

  const currentStep = (() => {
    const rows = collapseSteps(steps);
    const live = [...rows].reverse().find(r => r.status === 'start' || r.status === 'retry');
    return live?.label ?? (rows.length ? rows[rows.length - 1].label : 'Starting');
  })();

  const rail = (
    <Rail
      state={state}
      latest={latest}
      upToDate={upToDate}
      steps={steps}
      running={phase === 'updating'}
      finished={phase === 'done'}
      elapsed={elapsed}
      domain={domain}
    />
  );

  return (
    <WizardShell
      title="Update Postey"
      subtitle="In place, idempotent - your data and keys are untouched"
      progress={{ current: PHASE_INDEX[phase], total: 3 }}
    >
      {phase === 'loading' && (
        <Card>
          <p className="text-[13px] text-ink-soft">Loading session…</p>
        </Card>
      )}

      {phase === 'no-session' && (
        <Card
          footer={
            <BackButton onClick={() => void navigate({ to: '/' })} label="Back to postey.app" />
          }
        >
          <CardTitle title="No instance session" />
          {error && <ErrorBox>{error}</ErrorBox>}
          <p className="text-[13px] leading-relaxed text-ink-soft">
            Open this page from your instance link - the same id as your deploy URL:{' '}
            <code className="font-mono text-[12px]">/update?instance=&lt;id&gt;</code>. It was
            shown (and offered for copy) at the end of your deploy.
          </p>
        </Card>
      )}

      {phase === 'connect' && (
        <SplitShell rail={rail}>
          <div className="my-auto">
            <h2 className="text-[17px] font-semibold tracking-tight text-ink">
              Connect the account that owns this instance
            </h2>
            <p className="mb-5 mt-1 text-[13px] leading-relaxed text-ink-soft">
              A one-time grant so Postey can redeploy the workers in your account.
            </p>
            {error && <ErrorBox>{error}</ErrorBox>}
            <ConnectSection connect={connect} />
          </div>
        </SplitShell>
      )}

      {phase === 'review' && (
        <SplitShell rail={rail}>
          <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-100">
              <Check className="h-4 w-4 text-emerald-700" strokeWidth={2.4} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-semibold text-ink">
                {connect.cfEmail ? `Signed in as ${connect.cfEmail}` : 'Access verified'}
              </p>
              <p className="text-[10.5px] text-ink-soft">
                {connect.accounts.find(a => a.id === connect.accountId)?.name ?? 'Account verified'}
                {connect.installs.some(i => i.instance_name === state?.instanceName)
                  ? ` · owns ${state?.instanceName}`
                  : ''}
              </p>
            </div>
          </div>

          <h2 className="mt-5 text-[16.5px] font-semibold tracking-tight text-ink">
            {upToDate ? 'Already up to date' : 'Ready to update'}
          </h2>
          {error && (
            <div className="mt-3">
              <ErrorBox>{error}</ErrorBox>
            </div>
          )}
          {upToDate ? (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
              <span className="font-mono text-ink">{state?.instanceName}</span> is already on{' '}
              <span className="font-mono text-ink">v{latest}</span>, the latest release. You can
              still re-apply it - useful if a previous update was interrupted or something looks
              off.
            </p>
          ) : null}
          <FlightCheck />
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-soft">
            A failed update never takes down the running version, and the run resumes safely if
            interrupted.
          </p>
          <div className="mt-auto flex items-center justify-end gap-3 pt-6">
            <BackButton onClick={() => setPhase('connect')} />
            <PrimaryButton onClick={() => void runUpdate()} busy={busy} disabled={!connect.accountId}>
              {upToDate ? `Re-apply v${latest ?? ''}` : `Update to v${latest ?? 'latest'}`}
              <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
          </div>
        </SplitShell>
      )}

      {phase === 'updating' && (
        <SplitShell rail={rail}>
          <div className="my-auto">
            {error ? (
              <>
                <ErrorBox>{error}</ErrorBox>
                <PrimaryButton onClick={() => void runUpdate()} busy={busy}>
                  Retry - resumes where it failed
                </PrimaryButton>
              </>
            ) : (
              <>
                <Loader2 className="h-9 w-9 animate-spin text-accent" />
                <h2 className="mt-4 text-[17px] font-semibold tracking-tight text-ink">
                  {currentStep}…
                </h2>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                  {elapsed}s elapsed · a failed update never takes down the running version.
                </p>
                <p className="mt-4 text-[11.5px] text-ink-soft">
                  Keep this tab open until it finishes.
                </p>
              </>
            )}
          </div>
        </SplitShell>
      )}

      {phase === 'done' && (
        <SplitShell rail={rail}>
          <div className="my-auto">
            <div className="flex items-center gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                <Check className="h-5 w-5 text-emerald-700" strokeWidth={2.6} />
              </span>
              <div>
                <h2 className="text-[17.5px] font-semibold tracking-tight text-ink">
                  Updated to v{latest ?? 'latest'}
                </h2>
                <p className="mt-0.5 text-[12px] text-ink-soft">
                  {elapsed > 0 ? `Finished in ${elapsed}s · ` : ''}data, keys, and settings
                  untouched.
                </p>
              </div>
            </div>
            {result && (
              <div className="mt-5">
                <CopyField
                  label="Dashboard"
                  value={result.apiUrl}
                  href={
                    result.claimCode
                      ? `${result.apiUrl}/login#claim=${result.claimCode}`
                      : result.apiUrl
                  }
                  hint="Serving the new version already - nothing else to do."
                />
              </div>
            )}
          </div>
        </SplitShell>
      )}
    </WizardShell>
  );
}
