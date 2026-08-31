import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  BackButton,
  Card,
  CardTitle,
  ConnectSection,
  DangerButton,
  DESTROY_PLAN,
  ErrorBox,
  readSse,
  StepList,
  useConnect,
  WizardShell,
  wizardApi,
  type ResumeState,
  type StepEvent,
} from '../deploy/shared';

export const Route = createFileRoute('/destroy')({
  component: DestroyWizard,
  validateSearch: (s: Record<string, unknown>): { instance?: string } =>
    typeof s.instance === 'string' ? { instance: s.instance } : {},
});

type Phase = 'loading' | 'no-session' | 'connect' | 'confirm' | 'destroying' | 'done';

const PHASE_INDEX: Record<Phase, number> = {
  loading: 0,
  'no-session': 0,
  connect: 0,
  confirm: 1,
  destroying: 2,
  done: 2,
};

const inputClass =
  'h-11 w-full rounded-2xl border-none bg-white px-4 text-[13.5px] text-ink shadow-[inset_0_0_0_1px_#d8d1c8] transition-shadow placeholder:text-ink-soft/50 focus:shadow-[inset_0_0_0_1.5px_#dc2626] focus:outline-none';

function DestroyWizard(): ReactElement {
  const { instance: sessionId } = Route.useSearch();
  const navigate = useNavigate();
  const connect = useConnect('destroy', sessionId);

  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<ResumeState | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [retained, setRetained] = useState<{ bucket: string; reason: string } | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (connect.oauthError) setError(connect.oauthError);
  }, [connect.oauthError]);

  useEffect(() => {
    if (phase !== 'connect' || connect.tokenStatus !== 'ok') return;
    const owning = connect.installs.find(i => i.instance_name === state?.instanceName);
    if (owning) connect.setAccountId(owning.account_id);
    setPhase('confirm');
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
        if (!s.instanceName) {
          setPhase('no-session');
          return;
        }
        setState(s);
        setPhase(s.status === 'destroyed' ? 'done' : 'connect');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load session');
        setPhase('no-session');
      }
    })();
  }, [sessionId]);

  const runDestroy = async (): Promise<void> => {
    if (!state?.instanceName) return;
    setBusy(true);
    setError('');
    setSteps([]);
    setPhase('destroying');
    try {
      const res = await fetch(`/api/deploy/instance/${sessionId}/destroy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken: connect.token.trim(),
          accountId: connect.accountId,
          instanceName: state.instanceName,
          confirmName,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `destroy failed (${res.status})`);
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
          setPhase('done');
        } else if (payload.type === 'error') setError(String(payload.message));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'destroy failed');
    } finally {
      setBusy(false);
    }
  };

  const name = state?.instanceName ?? '';

  return (
    <WizardShell
      title="Destroy Postey"
      subtitle="Removes the instance from your Cloudflare account - no undo"
      progress={{ current: PHASE_INDEX[phase], total: 3 }}
      danger
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
            <code className="font-mono text-[12px]">/destroy?instance=&lt;id&gt;</code>.
          </p>
        </Card>
      )}

      {phase === 'connect' && (
        <Card>
          <CardTitle
            title={`Destroy “${name}”`}
            sub="Connect the account that owns this instance. You'll confirm on the next screen before anything is touched."
          />
          {error && <ErrorBox>{error}</ErrorBox>}
          <ConnectSection connect={connect} />
        </Card>
      )}

      {phase === 'confirm' && (
        <Card
          footer={
            <>
              <BackButton onClick={() => setPhase('connect')} />
              <DangerButton
                onClick={() => void runDestroy()}
                busy={busy}
                disabled={!connect.accountId || confirmName !== name}
              >
                Destroy forever
              </DangerButton>
            </>
          }
        >
          <CardTitle
            title="This deletes your email history"
            sub="Read what goes before typing the name."
          />
          {error && <ErrorBox>{error}</ErrorBox>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-red-50 p-4 ring-1 ring-red-100">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-red-800">
                Deleted permanently
              </p>
              <ul className="mt-2.5 space-y-1.5 text-[12.5px] leading-relaxed text-red-900/80">
                <li>· 3 workers (send, dashboard, inbound)</li>
                <li>· 2 queues + the delivery-event subscription</li>
                <li>· D1 database - email log, templates, keys, suppressions</li>
                <li>· R2 bucket - stored email bodies</li>
              </ul>
            </div>
            <div className="rounded-2xl bg-paper p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                Left untouched
              </p>
              <ul className="mt-2.5 space-y-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                <li>· Your domain and its DNS records</li>
                <li>· Email Sending onboarding on the zone</li>
                <li>· Your Workers plan and billing</li>
                <li>· Everything else in your account</li>
              </ul>
            </div>
          </div>
          <div className="mt-5">
            <label htmlFor="confirm-name" className="mb-1.5 block text-[12.5px] font-semibold text-ink">
              Type <code className="font-mono">{name}</code> to confirm
            </label>
            <input
              id="confirm-name"
              value={confirmName}
              onChange={e => setConfirmName(e.target.value)}
              placeholder={name}
              autoComplete="off"
              className={inputClass}
            />
          </div>
        </Card>
      )}

      {(phase === 'destroying' || phase === 'done') && (
        <Card
          footer={
            phase === 'destroying' && error ? (
              <DangerButton onClick={() => void runDestroy()} busy={busy}>
                Retry teardown
              </DangerButton>
            ) : phase === 'done' ? (
              <BackButton onClick={() => void navigate({ to: '/' })} label="Back to postey.app" />
            ) : undefined
          }
        >
          <CardTitle
            title={phase === 'done' ? 'Instance destroyed' : 'Tearing down…'}
            sub={
              phase === 'done'
                ? 'Your domain, DNS, and the rest of your Cloudflare account are untouched.'
                : undefined
            }
          />
          {phase === 'destroying' && error && <ErrorBox>{error}</ErrorBox>}
          {(phase === 'destroying' || steps.length > 0) && (
            <StepList steps={steps} plan={DESTROY_PLAN} />
          )}
          {phase === 'done' && retained && (
            <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
              One thing needs your attention: the bucket{' '}
              <code className="font-mono font-medium">{retained.bucket}</code> was kept -{' '}
              {retained.reason} It keeps costing R2 storage until you remove it in the Cloudflare
              dashboard (R2 → {retained.bucket} → Settings → Delete).
            </p>
          )}
          {phase === 'done' && (
            <p className="mt-4 text-[13px] text-ink-soft">
              Changed your mind?{' '}
              <a
                href="/deploy"
                className="font-semibold text-accent underline decoration-accent/40 underline-offset-2"
              >
                Deploy a fresh instance
              </a>{' '}
              any time.
            </p>
          )}
        </Card>
      )}
    </WizardShell>
  );
}
