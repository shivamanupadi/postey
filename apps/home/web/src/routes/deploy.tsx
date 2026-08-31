import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowRight, Check, KeyRound, Loader2, MailCheck, Server, ShieldCheck } from 'lucide-react';
import {
  AccentBox,
  BackButton,
  Card,
  CardTitle,
  ConnectSection,
  CopyField,
  createSession,
  currentStepLabel,
  ErrorBox,
  PrimaryButton,
  PROVISION_PLAN,
  readSse,
  runIsFresh,
  SelectField,
  SplitShell,
  TextField,
  useConnect,
  WizardRail,
  WizardShell,
  wizardApi,
  type ResumeState,
  type StepEvent,
} from '../deploy/shared';

export const Route = createFileRoute('/deploy')({
  component: DeployWizard,
  validateSearch: (s: Record<string, unknown>): { instance?: string } =>
    typeof s.instance === 'string' ? { instance: s.instance } : {},
});

type Phase = 'intro' | 'connect' | 'setup' | 'deploying' | 'failed' | 'done';

const PHASE_INDEX: Record<Phase, number> = {
  intro: 0,
  connect: 1,
  setup: 2,
  deploying: 3,
  failed: 3,
  done: 4,
};

const INTERRUPTED_MSG =
  'The previous deploy was interrupted before it finished. Everything already created is reused. Connect again and deploy to pick up where it left off.';

const failedMsg = (detail: string): string =>
  `The previous deploy failed: ${detail} Fix what it points at, connect again, and deploy - everything already created is reused.`;

function DeployWizard(): ReactElement {
  const { instance: sessionId } = Route.useSearch();
  const navigate = useNavigate();
  const connect = useConnect('deploy', sessionId);

  const [phase, setPhase] = useState<Phase>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [latest, setLatest] = useState<string | null>(null);

  const [instanceName, setInstanceName] = useState('postey');
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [subdomain, setSubdomain] = useState('mail');

  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{
    apiUrl: string;
    sendUrl: string;
    claimCode?: string;
  } | null>(null);
  const startedRef = useRef(false);
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    void wizardApi<{ version?: string }>('/latest-version')
      .then(d => setLatest(d.version ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (connect.oauthError) {
      setError(connect.oauthError);
      setPhase('connect');
    } else if (connect.oauthSignedIn) {
      setPhase(p => (p === 'intro' ? 'connect' : p));
    }
  }, [connect.oauthError, connect.oauthSignedIn]);

  const stopPolling = (): void => {
    if (pollRef.current !== undefined) {
      window.clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
  };
  useEffect(() => stopPolling, []);

  // Reattach to a deploy that's running server-side (this tab refreshed
  // mid-run, or another tab owns the SSE stream): watch the instance row.
  const startPolling = (): void => {
    stopPolling();
    pollRef.current = window.setInterval(() => {
      void wizardApi<ResumeState>(`/instance/${sessionId}`)
        .then(state => {
          setSteps(state.steps ?? []);
          if (state.status === 'ready' && state.apiUrl) {
            stopPolling();
            setResult({ apiUrl: state.apiUrl, sendUrl: state.sendUrl ?? '' });
            setPhase('done');
          } else if (state.status === 'failed') {
            stopPolling();
            setError(state.error ? failedMsg(state.error) : INTERRUPTED_MSG);
            setPhase('failed');
          } else if (!runIsFresh(state)) {
            stopPolling();
            setError(INTERRUPTED_MSG);
            setPhase('connect');
          }
        })
        .catch(() => undefined);
    }, 3000);
  };

  // Resume a returning ?instance= session - or hand it to the right flow.
  useEffect(() => {
    if (!sessionId || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const state = await wizardApi<ResumeState>(`/instance/${sessionId}`).catch(() => null);
      if (!state) return;
      if (state.status === 'ready') {
        // A finished session means "manage this instance" - that's /update.
        void navigate({ to: '/update', search: { instance: sessionId }, replace: true });
        return;
      }
      if (state.instanceName) setInstanceName(state.instanceName);
      if (state.steps) setSteps(state.steps);
      if (state.sendingDomain) {
        // Restore the domain choice so a resumed run re-deploys onto the same
        // hostname; the zones fetch replaces this seed once connected.
        setZones([{ id: state.sendingDomain.zoneId, name: state.sendingDomain.zoneName }]);
        setZoneId(state.sendingDomain.zoneId);
        setSubdomain(state.sendingDomain.subdomain);
      }
      if (state.status === 'deploying' && runIsFresh(state)) {
        // The run is still going server-side - show it live, no token needed.
        setPhase('deploying');
        startPolling();
      } else if (state.status === 'failed' || state.status === 'deploying') {
        setError(state.error ? failedMsg(state.error) : INTERRUPTED_MSG);
        setPhase('connect');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Elapsed ticker while the run is live.
  useEffect(() => {
    if (phase !== 'deploying') return;
    const startedAt = Date.now() - elapsed * 1000;
    const t = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const begin = async (): Promise<void> => {
    if (sessionId) {
      setPhase('connect');
      return;
    }
    setBusy(true);
    try {
      const id = await createSession();
      void navigate({ to: '/deploy', search: { instance: id }, replace: true });
      setError('');
      setPhase('connect');
    } catch {
      setError('Could not reach the server to start. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  // Zones for the sending-domain picker (per chosen account).
  useEffect(() => {
    if (phase !== 'setup' || !connect.accountId || !sessionId) return;
    void wizardApi<{ id: string; name: string }[]>(`/instance/${sessionId}/zones`, {
      apiToken: connect.token.trim(),
      accountId: connect.accountId,
    })
      .then(list => {
        setZones(list);
        setZoneId(prev => (list.some(z => z.id === prev) ? prev : (list[0]?.id ?? '')));
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'zone list failed');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, connect.accountId, sessionId]);

  const zoneName = zones.find(z => z.id === zoneId)?.name ?? '';
  // Mirrors the server's schema so a bad value is caught here, not as a 400.
  const nameOk = /^[a-z][a-z0-9-]{2,20}$/.test(instanceName.trim());
  const sub = subdomain.trim();
  const subOk = sub === '' || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(sub);
  const sendingHost = sub ? `${sub}.${zoneName || 'example.com'}` : zoneName || 'example.com';

  const existing = connect.installs.filter(i => i.account_id === connect.accountId);

  const deploy = async (): Promise<void> => {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    setBusy(true);
    setError('');
    setSteps([]);
    setElapsed(0);
    setPhase('deploying');
    try {
      const res = await fetch(`/api/deploy/instance/${sessionId}/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken: connect.token.trim(),
          accountId: connect.accountId,
          instanceName: instanceName.trim(),
          sendingDomain: { zoneId: zone.id, zoneName: zone.name, subdomain: sub },
        }),
      });
      if (res.status === 409) {
        // A run for this instance is already going (e.g. another tab) - watch it.
        startPolling();
        return;
      }
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `deploy request failed (${res.status})`);
      }
      const terminal = await readSse(res, payload => {
        if (payload.type === 'step') {
          setSteps(prev => [...prev, payload as unknown as StepEvent]);
        } else if (payload.type === 'done') {
          setResult(payload as unknown as { apiUrl: string; sendUrl: string; claimCode?: string });
          setPhase('done');
        } else if (payload.type === 'error') {
          setError(String(payload.message));
          setPhase('failed');
        }
      });
      // Stream ended without done/error (tab hiccup, proxy timeout): reattach.
      if (!terminal) startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'deploy failed');
      setPhase('failed');
    } finally {
      setBusy(false);
    }
  };

  const onboardWaiting = steps.filter(s => s.stepId === 'onboard').at(-1)?.status === 'retry';
  const resumeUrl = sessionId ? `${window.location.origin}/deploy?instance=${sessionId}` : '';

  const rail = (
    <WizardRail
      name={instanceName.trim() || 'postey'}
      sub={zoneId ? sendingHost : undefined}
      meta={
        <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-ink-soft">
          installs
          <span className="rounded-md bg-accent-soft px-2 py-0.5 font-semibold text-accent-deep">
            {latest ? `v${latest}` : 'latest release'}
          </span>
        </span>
      }
      planLabel="Deploy plan"
      plan={PROVISION_PLAN}
      steps={steps}
      running={phase === 'deploying'}
      finished={phase === 'done'}
      elapsed={elapsed}
    />
  );

  return (
    <WizardShell
      title="Deploy Postey"
      subtitle="Your own email platform, in your Cloudflare account"
      progress={{ current: PHASE_INDEX[phase], total: 5 }}
    >
      {phase === 'intro' && (
        <Card>
          <div className="mb-1 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[17px] font-semibold tracking-tight text-ink">
                Deploy Postey to your Cloudflare account
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                Here's what will happen
              </p>
            </div>
            <PrimaryButton onClick={() => void begin()} busy={busy}>
              Get started
              <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
          </div>
          <div className="mb-4" />
          {error && <ErrorBox>{error}</ErrorBox>}
          <div className="space-y-2.5">
            {[
              {
                icon: KeyRound,
                title: 'Connect your account',
                desc: 'Sign in with Cloudflare or paste a scoped API token. Access is used for this run only and never stored.',
              },
              {
                icon: Server,
                title: 'We set Postey up for you',
                desc: 'Three workers, a D1 database, an R2 bucket, and a delivery-events queue - live on your workers.dev URLs in a few minutes.',
              },
              {
                icon: MailCheck,
                title: 'One two-click step on Cloudflare',
                desc: 'Email Sending onboarding has no public API yet, so the wizard deep-links you to the dashboard and detects completion automatically.',
              },
              {
                icon: ShieldCheck,
                title: 'Yours, entirely',
                desc: 'Your domain, your data, your sender reputation. No per-email middleman, nothing leaves your account.',
              },
            ].map(item => (
              <div key={item.title} className="flex gap-3.5 rounded-2xl bg-paper px-4 py-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft">
                  <item.icon className="h-[18px] w-[18px] text-accent" />
                </span>
                <div>
                  <p className="text-[13.5px] font-semibold text-ink">{item.title}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-soft">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-center text-[11.5px] text-ink-soft">
            Requires the <strong className="text-ink">Workers Paid</strong> plan ($5/mo) with your
            sending domain on Cloudflare DNS.
          </p>
        </Card>
      )}

      {phase === 'connect' && (
        <SplitShell rail={rail}>
          <div className="my-auto">
            <h2 className="text-[17px] font-semibold tracking-tight text-ink">
              Connect your Cloudflare account
            </h2>
            <p className="mb-5 mt-1 text-[13px] leading-relaxed text-ink-soft">
              Verified live - the wizard checks access before touching anything.
            </p>
            {error && <ErrorBox>{error}</ErrorBox>}
            <ConnectSection connect={connect} />
          </div>
          <div className="mt-auto flex items-center justify-end gap-3 pt-6">
            <BackButton onClick={() => setPhase('intro')} />
            <PrimaryButton
              onClick={() => {
                setError('');
                setPhase('setup');
              }}
              disabled={connect.tokenStatus !== 'ok'}
            >
              Continue
              <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
          </div>
        </SplitShell>
      )}

      {phase === 'setup' && (
        <SplitShell rail={rail}>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Set up the instance</h2>
          <p className="mb-5 mt-1 text-[13px] leading-relaxed text-ink-soft">
            Two choices - everything else is automatic.
          </p>
          {error && <ErrorBox>{error}</ErrorBox>}
          {existing.length > 0 && (
            <AccentBox>
              This account already runs {existing.length === 1 ? 'a Postey install' : `${existing.length} Postey installs`}{' '}
              ({existing.map(i => i.instance_name).join(', ')}). Re-deploying with the same
              instance name updates it in place instead of creating a second one.
            </AccentBox>
          )}
          <div className="space-y-5">
            <SelectField
              id="zone"
              label="Sending domain"
              value={zoneId}
              onChange={e => setZoneId(e.target.value)}
            >
              {zones.length === 0 && <option value="">Loading zones…</option>}
              {zones.map(z => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </SelectField>
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                id="subdomain"
                label="Sending subdomain"
                value={subdomain}
                onChange={e => setSubdomain(e.target.value)}
                placeholder="mail (empty = apex)"
                help={
                  subOk
                    ? 'Keeps your root domain’s mail reputation separate - recommended.'
                    : 'Lowercase letters, digits, and dashes.'
                }
              />
              <TextField
                id="instance-name"
                label="Instance name"
                value={instanceName}
                onChange={e => setInstanceName(e.target.value)}
                placeholder="postey"
                help={
                  nameOk
                    ? 'Prefixes every resource in your account.'
                    : '3-21 chars: lowercase letters, digits, dashes; starts with a letter.'
                }
              />
            </div>
            <div className="rounded-xl bg-paper px-4 py-3 text-[12.5px] leading-relaxed text-ink-soft">
              Your emails will send from{' '}
              <code className="font-mono font-medium text-ink">anything@{sendingHost}</code>. The
              dashboard and API deploy to workers.dev URLs - nothing else on this domain changes.
            </div>
          </div>
          <div className="mt-auto flex items-center justify-end gap-3 pt-6">
            <BackButton onClick={() => setPhase('connect')} />
            <PrimaryButton
              onClick={() => void deploy()}
              busy={busy}
              disabled={!zoneId || !nameOk || !subOk}
            >
              Deploy to Cloudflare
              <ArrowRight className="h-4 w-4" />
            </PrimaryButton>
          </div>
        </SplitShell>
      )}

      {(phase === 'deploying' || phase === 'failed') && (
        <SplitShell rail={rail}>
          <div className="my-auto">
            {phase === 'failed' ? (
              <>
                <h2 className="mb-3 text-[17px] font-semibold tracking-tight text-ink">
                  Deploy failed
                </h2>
                {error && <ErrorBox>{error}</ErrorBox>}
                <p className="mb-5 text-[12.5px] leading-relaxed text-ink-soft">
                  Everything already created is reused on retry.
                </p>
                <div className="flex items-center gap-3">
                  <BackButton onClick={() => setPhase('setup')} label="Change settings" />
                  <PrimaryButton
                    onClick={() => void deploy()}
                    busy={busy}
                    disabled={connect.tokenStatus !== 'ok' || !zoneId}
                  >
                    Retry - resumes where it failed
                  </PrimaryButton>
                </div>
              </>
            ) : onboardWaiting ? (
              <>
                <p className="flex items-center gap-2 text-[14px] font-semibold text-accent-deep">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
                  Your turn: one manual step (two clicks)
                </p>
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-soft">
                  Open the dashboard, select <strong className="text-ink">Onboard Domain</strong>,
                  pick <strong className="text-ink">{sendingHost}</strong>, and select{' '}
                  <strong className="text-ink">Done</strong>. DNS records are created automatically
                  and detection here is automatic too - just come back to this tab.
                </p>
                <a
                  href="https://dash.cloudflare.com/?to=/:account/email-service/sending"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-block rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-accent-deep"
                >
                  Open Email Sending in the dashboard →
                </a>
                <p className="mt-4 text-[11.5px] text-ink-soft">
                  {elapsed}s elapsed · waiting for the onboarding to appear.
                </p>
              </>
            ) : (
              <>
                <Loader2 className="h-9 w-9 animate-spin text-accent" />
                <h2 className="mt-4 text-[17px] font-semibold tracking-tight text-ink">
                  {currentStepLabel(steps)}…
                </h2>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                  {elapsed}s elapsed · provisioning into your account.
                </p>
                <p className="mt-4 text-[11.5px] text-ink-soft">
                  Keep this tab open - or come back later with this page's URL.
                </p>
              </>
            )}
          </div>
        </SplitShell>
      )}

      {phase === 'done' && result && (
        <div className="space-y-4">
          <SplitShell rail={rail}>
            <div className="my-auto">
              <div className="flex items-center gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                  <Check className="h-5 w-5 text-emerald-700" strokeWidth={2.6} />
                </span>
                <div>
                  <h2 className="text-[17.5px] font-semibold tracking-tight text-ink">
                    Your instance is live 🎉
                  </h2>
                  <p className="mt-0.5 text-[12px] text-ink-soft">
                    Everything below is running in your Cloudflare account.
                  </p>
                </div>
              </div>
              <div className="mt-5 space-y-4">
                <CopyField
                  label="Dashboard"
                  value={result.apiUrl}
                  href={
                    result.claimCode
                      ? `${result.apiUrl}/login#claim=${result.claimCode}`
                      : result.apiUrl
                  }
                  hint={
                    result.claimCode
                      ? 'This link carries your one-time claim code - open it now to create the operator account. The code is not stored anywhere else.'
                      : undefined
                  }
                />
                <CopyField
                  label="Send API endpoint"
                  value={`${result.sendUrl}/api/emails`}
                  hint="Create an API key in the dashboard, then POST Resend-shaped payloads here."
                />
                {resumeUrl && (
                  <CopyField
                    label="Instance link - bookmark this"
                    value={resumeUrl}
                    hint="The handle for updating and destroying this instance later. It is not stored anywhere else."
                  />
                )}
              </div>
            </div>
          </SplitShell>
          <div className="mx-auto w-full max-w-[900px] rounded-[20px] border border-line-soft bg-white p-7 shadow-[0_12px_40px_-16px_rgba(30,25,18,0.18)]">
            <CardTitle title="Next steps" />
            <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-ink-soft">
              <li>
                Open the dashboard{result.claimCode ? ' via the claim link above' : ''} and create
                your operator account.
              </li>
              <li>Create an API key and send a test email to a verified address - it's free.</li>
              <li>
                Point your app at{' '}
                <code className="font-mono text-[12px] text-ink">{result.sendUrl}/api/emails</code>{' '}
                - Resend SDKs work by changing the base URL.
              </li>
              <li>
                When a new version ships,{' '}
                <a
                  className="text-accent underline decoration-accent/40 underline-offset-2"
                  href={`/update?instance=${sessionId ?? ''}`}
                >
                  update in one click
                </a>
                .
              </li>
            </ol>
          </div>
        </div>
      )}
    </WizardShell>
  );
}
