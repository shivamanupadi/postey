import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import {
  BackButton,
  Card,
  CardTitle,
  ConnectSection,
  CopyField,
  ErrorBox,
  NoteBox,
  PrimaryButton,
  PROVISION_PLAN,
  readSse,
  StepList,
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

function VersionArrow({ from, to }: { from: string | null; to: string | null }): ReactElement {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[13px]">
      <span className="rounded-md bg-paper px-2 py-0.5 text-ink">v{from ?? '?'}</span>
      <span className="text-ink-soft">→</span>
      <span className="rounded-md bg-accent-soft px-2 py-0.5 font-medium text-accent-deep">
        v{to ?? '?'}
      </span>
    </span>
  );
}

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

  const runUpdate = async (): Promise<void> => {
    if (!state?.sendingDomain || !state.instanceName) return;
    setBusy(true);
    setError('');
    setSteps([]);
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
        <Card>
          <CardTitle
            title={`Update “${state?.instanceName ?? ''}”`}
            sub="Connect the account that owns this instance."
          />
          <div className="mb-5 space-y-2 rounded-2xl bg-paper px-4 py-3.5 text-[13px] text-ink-soft">
            <div className="flex items-center justify-between gap-4">
              <span>Sending domain</span>
              <span className="font-mono text-ink">{domain}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span>Version</span>
              {upToDate ? (
                <span className="inline-flex items-center gap-1.5 font-mono text-[13px] text-ink">
                  v{state?.deployedVersion}
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700">
                    latest
                  </span>
                </span>
              ) : (
                <VersionArrow from={state?.deployedVersion ?? null} to={latest} />
              )}
            </div>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
          <ConnectSection connect={connect} />
        </Card>
      )}

      {phase === 'review' && (
        <Card
          footer={
            <>
              <BackButton onClick={() => setPhase('connect')} />
              <PrimaryButton onClick={() => void runUpdate()} busy={busy} disabled={!connect.accountId}>
                {upToDate ? `Re-apply v${latest ?? ''}` : 'Update instance'}
                <ArrowRight className="h-4 w-4" />
              </PrimaryButton>
            </>
          }
        >
          <CardTitle title={upToDate ? 'Already up to date' : 'Ready to update'} />
          {error && <ErrorBox>{error}</ErrorBox>}
          {upToDate ? (
            <p className="text-[13px] leading-relaxed text-ink-soft">
              <span className="font-mono text-ink">{state?.instanceName}</span> is already on{' '}
              <span className="font-mono text-ink">v{latest}</span>, the latest release. You can
              still re-apply it - useful if a previous update was interrupted or something looks
              off.
            </p>
          ) : (
            <p className="text-[13px] leading-relaxed text-ink-soft">
              Updates <span className="font-mono text-ink">{state?.instanceName}</span>{' '}
              {state?.deployedVersion ? (
                <>
                  from <span className="font-mono text-ink">v{state.deployedVersion}</span>{' '}
                </>
              ) : null}
              {latest ? (
                <>
                  to <span className="font-mono font-medium text-accent">v{latest}</span>
                </>
              ) : (
                'to the latest release'
              )}
              . A failed update never takes down the running version, and the run resumes safely if
              interrupted.
            </p>
          )}
          <NoteBox>
            Worker bundles and D1 migrations ship prebuilt from the release registry - the same
            model as Traks updates.
          </NoteBox>
        </Card>
      )}

      {(phase === 'updating' || phase === 'done') && (
        <div className="space-y-4">
          <Card
            footer={
              phase === 'updating' && error ? (
                <PrimaryButton onClick={() => void runUpdate()} busy={busy}>
                  Retry - resumes where it failed
                </PrimaryButton>
              ) : undefined
            }
          >
            <CardTitle
              title={phase === 'done' ? `Updated to v${latest ?? 'latest'} ✓` : 'Updating…'}
              sub={phase === 'done' ? undefined : 'Keep this tab open until it finishes.'}
            />
            {phase === 'updating' && error && <ErrorBox>{error}</ErrorBox>}
            <StepList steps={steps} plan={PROVISION_PLAN} />
          </Card>
          {phase === 'done' && result && (
            <Card>
              <CopyField
                label="Dashboard"
                value={result.apiUrl}
                href={
                  result.claimCode
                    ? `${result.apiUrl}/login#claim=${result.claimCode}`
                    : result.apiUrl
                }
                hint="Your instance is serving the new version - data, keys, and settings untouched."
              />
            </Card>
          )}
        </div>
      )}
    </WizardShell>
  );
}
