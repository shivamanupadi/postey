/**
 * Shared pieces of the three wizard flows - /deploy (install), /update, and
 * /destroy. Each flow is its own full-page route (no marketing chrome); what
 * lives here is the design system (shell, cards, buttons, token field, step
 * list), the wizard session/connect logic, and the SSE plumbing they share.
 * Same architecture as Traks' wizards, in Postey's cream + coral theme.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { ArrowLeft, Check, ExternalLink, Loader2, XCircle } from 'lucide-react';

/* ── pre-filled Cloudflare token URL ────────────────────────────── */

/** Opens the dashboard's token builder with most permissions pre-selected.
 *  "Email Sending: Edit" has no stable permission-group key while the product
 *  is in beta - the UI tells users to add that one by hand. */
export const INSTALLER_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([
    { key: 'workers_scripts', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'workers_r2', type: 'edit' },
    { key: 'queues', type: 'edit' },
    { key: 'zone', type: 'read' },
    { key: 'dns_records', type: 'read' },
    { key: 'account_settings', type: 'read' },
    { key: 'user_details', type: 'read' },
  ])
)}&name=${encodeURIComponent('Postey Installer')}`;

export const TOKEN_PERMISSIONS = [
  'Workers Scripts: Edit',
  'D1: Edit',
  'Workers R2 Storage: Edit',
  'Queues: Edit',
  'Email Sending: Edit',
  'Zone: Read',
  'DNS: Read',
  'Account Settings: Read',
  'User Details: Read',
];

/* ── types ──────────────────────────────────────────────────────── */

export type Flow = 'deploy' | 'update' | 'destroy';

export interface StepEvent {
  stepId: string;
  label: string;
  status: 'start' | 'ok' | 'fail' | 'retry';
  detail?: string;
}

export interface ResumeState {
  status: 'new' | 'deploying' | 'ready' | 'failed' | 'destroyed';
  instanceName: string | null;
  apiUrl: string | null;
  sendUrl: string | null;
  sendingDomain: { zoneId: string; zoneName: string; subdomain: string } | null;
  deployedVersion: string | null;
  error: string | null;
  steps: StepEvent[];
  updatedAt: number;
}

export interface Account {
  id: string;
  name: string;
}

export interface Install {
  id: string;
  account_id: string;
  instance_name: string;
  api_url: string | null;
  deployed_version: string | null;
}

/** Mirrors RUN_STALE_MS server-side: a quieter 'deploying' row is dead. */
export const RUN_STALE_MS = 3 * 60_000;

export const runIsFresh = (state: ResumeState): boolean =>
  Date.now() - state.updatedAt < RUN_STALE_MS;

/** The provision plan, in engine order. Shown up-front so users see the whole
 *  runway, not a log that grows line by line. Labels match the engine's so
 *  live events merge onto their planned rows. */
export const PROVISION_PLAN: { stepId: string; label: string }[] = [
  { stepId: 'preflight', label: 'Check account readiness' },
  { stepId: 'd1', label: 'Create D1 database' },
  { stepId: 'db-migrations', label: 'Apply database migrations' },
  { stepId: 'bucket', label: 'Create R2 bodies bucket' },
  { stepId: 'queue', label: 'Create send queue' },
  { stepId: 'events-queue', label: 'Create delivery-events queue' },
  { stepId: 'send-worker', label: 'Deploy send worker' },
  { stepId: 'event-subscription', label: 'Subscribe to delivery events' },
  { stepId: 'inbound-worker', label: 'Deploy inbound worker' },
  { stepId: 'onboard', label: 'Onboard your domain to Email Sending' },
  { stepId: 'assets', label: 'Upload dashboard assets' },
  { stepId: 'api-worker', label: 'Deploy dashboard worker' },
  { stepId: 'smoke', label: 'Verify the deployment' },
  { stepId: 'claim', label: 'Secure the first sign-up' },
];

export const DESTROY_PLAN: { stepId: string; label: string }[] = [
  { stepId: 'workers', label: 'Delete workers' },
  { stepId: 'queue-teardown', label: 'Delete queues' },
  { stepId: 'bucket-teardown', label: 'Empty and delete bodies bucket' },
  { stepId: 'storage-teardown', label: 'Delete database' },
];

/* ── plumbing ───────────────────────────────────────────────────── */

export async function wizardApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/deploy${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data?.data as T;
}

/** Create a fresh wizard session row; returns its id. */
export async function createSession(): Promise<string> {
  return (await wizardApi<{ id: string }>('/instance', {})).id;
}

/** Keep one row per stepId, latest status wins (streams re-emit on retry). */
export function collapseSteps(events: StepEvent[]): StepEvent[] {
  const rows: StepEvent[] = [];
  for (const ev of events) {
    const existing = rows.findIndex(s => s.stepId === ev.stepId);
    if (existing >= 0) rows[existing] = ev;
    else rows.push(ev);
  }
  return rows;
}

/** Read an SSE response stream, invoking onEvent per data: payload. Resolves
 *  true if a terminal done/error event arrived, false if the stream just ended. */
export async function readSse(
  res: Response,
  onEvent: (payload: Record<string, unknown>) => void
): Promise<boolean> {
  if (!res.body) return false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const raw of events) {
      const line = raw.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (payload.type === 'done' || payload.type === 'error') terminal = true;
      onEvent(payload);
    }
  }
  return terminal;
}

/* ── shell ──────────────────────────────────────────────────────── */

export function WizardShell({
  title,
  subtitle,
  progress,
  danger = false,
  children,
}: {
  title: string;
  subtitle: string;
  progress: { current: number; total: number };
  danger?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="min-h-screen bg-paper px-4 py-10">
      {/* dot grid, fading out down the page */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,77,109,0.08) 1px, transparent 1px)',
          backgroundSize: '26px 26px',
          maskImage: 'linear-gradient(to bottom, black 0%, transparent 65%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 65%)',
        }}
      />
      <a
        href="/"
        className="fixed left-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-semibold text-ink-soft transition hover:bg-white hover:text-ink hover:shadow-sm"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        postey.app
      </a>
      <div className="relative">
        <div className="mb-7 flex flex-col items-center">
          <a href="/" aria-label="Back to postey.app" className="transition-transform hover:scale-105">
            <img src="/logo.svg" alt="Postey" className="h-10 w-10" />
          </a>
          <h1 className="display mt-3 font-display text-[27px] text-ink">{title}</h1>
          <p className="mt-1 text-[13.5px] text-ink-soft">{subtitle}</p>
        </div>
        <div className="mb-8 flex items-center justify-center gap-2" aria-hidden>
          {Array.from({ length: progress.total }, (_, i) => (
            <span
              key={i}
              className={`h-[4px] rounded-full transition-all duration-300 ${
                i === progress.current
                  ? `w-10 ${danger ? 'bg-red-600' : 'bg-accent'}`
                  : i < progress.current
                    ? 'w-5 bg-ink/30'
                    : 'w-5 bg-line'
              }`}
            />
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Card({
  children,
  footer,
  wide = false,
}: {
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): ReactElement {
  return (
    <div
      className={`mx-auto w-full ${wide ? 'max-w-[640px]' : 'max-w-[560px]'} rounded-[20px] border border-line-soft bg-white shadow-[0_12px_40px_-16px_rgba(30,25,18,0.18)]`}
    >
      <div className="p-7">{children}</div>
      {footer && (
        <div className="flex items-center justify-end gap-3 border-t border-line-soft px-7 py-4">
          {footer}
        </div>
      )}
    </div>
  );
}

export function CardTitle({ title, sub }: { title: string; sub?: string }): ReactElement {
  return (
    <>
      <h2 className="mb-1 text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
      {sub && <p className="mb-5 text-[13px] leading-relaxed text-ink-soft">{sub}</p>}
    </>
  );
}

/* ── buttons ────────────────────────────────────────────────────── */

export function PrimaryButton({
  children,
  onClick,
  disabled,
  busy,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}): ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full bg-ink px-6 text-[13.5px] font-semibold text-white transition-all hover:-translate-y-px hover:bg-black hover:shadow-md disabled:pointer-events-none disabled:opacity-40"
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function DangerButton({
  children,
  onClick,
  disabled,
  busy,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}): ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-full bg-red-600 px-6 text-[13.5px] font-semibold text-white transition-all hover:-translate-y-px hover:bg-red-700 hover:shadow-md disabled:pointer-events-none disabled:opacity-40"
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function BackButton({
  onClick,
  disabled,
  label = 'Back',
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}): ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mr-auto inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-full px-4 text-[13.5px] font-semibold text-ink-soft transition-colors hover:bg-paper hover:text-ink disabled:pointer-events-none disabled:opacity-40"
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </button>
  );
}

/* ── notes & fields ─────────────────────────────────────────────── */

export function ErrorBox({ children }: { children: ReactNode }): ReactElement {
  return (
    <p className="mb-4 break-words rounded-xl bg-red-50 px-4 py-3 text-[12.5px] leading-relaxed text-red-800 ring-1 ring-red-100">
      {children}
    </p>
  );
}

export function NoteBox({ children }: { children: ReactNode }): ReactElement {
  return (
    <p className="mb-4 rounded-xl bg-paper px-4 py-3 text-[12.5px] leading-relaxed text-ink-soft">
      {children}
    </p>
  );
}

export function AccentBox({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="mb-4 rounded-xl bg-accent-soft px-4 py-3 text-[12.5px] leading-relaxed text-accent-deep">
      {children}
    </div>
  );
}

const inputClass =
  'h-11 w-full rounded-2xl border-none bg-white px-4 text-[13.5px] text-ink shadow-[inset_0_0_0_1px_#d8d1c8] transition-shadow placeholder:text-ink-soft/50 focus:shadow-[inset_0_0_0_1.5px_#ff4d6d] focus:outline-none';

export function TextField({
  id,
  label,
  help,
  ...props
}: { id: string; label: string; help?: ReactNode } & React.InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-semibold text-ink">
        {label}
      </label>
      <input id={id} {...props} className={inputClass} />
      {help && <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">{help}</p>}
    </div>
  );
}

export function SelectField({
  id,
  label,
  children,
  ...props
}: {
  id: string;
  label: string;
  children: ReactNode;
} & React.SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-semibold text-ink">
        {label}
      </label>
      <select id={id} {...props} className={`${inputClass} cursor-pointer`}>
        {children}
      </select>
    </div>
  );
}

export function TokenField({
  id,
  label,
  help,
  linkLabel,
  linkUrl,
  value,
  onChange,
  status,
  statusDetail,
  errorHelp,
}: {
  id: string;
  label: string;
  help: ReactNode;
  linkLabel: string;
  linkUrl: string;
  value: string;
  onChange: (v: string) => void;
  status?: 'checking' | 'ok' | 'bad';
  statusDetail?: string;
  errorHelp?: ReactNode;
}): ReactElement {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Paste the token here"
        autoComplete="off"
        className={inputClass}
      />
      <div className="mt-1.5 flex items-start justify-between gap-3">
        <p className="text-[11.5px] leading-relaxed text-ink-soft">
          {status === 'checking' ? (
            <span className="inline-flex items-center gap-1.5 text-ink-soft">
              <Loader2 className="h-3 w-3 animate-spin" /> Checking…
            </span>
          ) : status === 'ok' ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
              <Check className="h-3 w-3" /> {statusDetail ?? 'Looks good'}
            </span>
          ) : status === 'bad' ? (
            <span className="text-red-700">
              {statusDetail ?? 'Token check failed'}
              {errorHelp && <span className="mt-0.5 block text-ink-soft">{errorHelp}</span>}
            </span>
          ) : (
            help
          )}
        </p>
        <a
          href={linkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-semibold text-accent underline-offset-2 hover:underline"
        >
          {linkLabel}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

/** Mono value with a copy button; optionally rendered as a link. */
export function CopyField({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: string;
  href?: string;
  hint?: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{label}</p>
      <div className="mt-1.5 flex items-center gap-2 rounded-xl bg-paper px-3 py-2.5">
        {href ? (
          <a
            className="min-w-0 flex-1 truncate font-mono text-[13px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {value}
          </a>
        ) : (
          <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{value}</code>
        )}
        <button
          type="button"
          onClick={copy}
          className={`shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs font-medium transition ${
            copied ? 'bg-accent-soft text-accent-deep' : 'text-ink-soft hover:bg-paper-deep hover:text-ink'
          }`}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      {hint && <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">{hint}</p>}
    </div>
  );
}

/* ── step list ──────────────────────────────────────────────────── */

type RowStatus = StepEvent['status'] | 'pending';

function StepIcon({ status }: { status: RowStatus }): ReactElement {
  if (status === 'ok')
    return <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2.4} />;
  if (status === 'fail') return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />;
  if (status === 'start' || status === 'retry')
    return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />;
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
      <span className="h-1.5 w-1.5 rounded-full bg-line" />
    </span>
  );
}

/** Progress list. With a `plan`, the full runway renders up-front (pending rows
 *  dimmed) and live events light rows up as they arrive; without one it renders
 *  events in arrival order. */
export function StepList({
  steps,
  plan,
}: {
  steps: StepEvent[];
  plan?: { stepId: string; label: string }[];
}): ReactElement {
  const seen = collapseSteps(steps);
  const byId = new Map(seen.map(s => [s.stepId, s]));
  const rows: { stepId: string; label: string; status: RowStatus; detail?: string }[] = [];
  if (plan) {
    for (const p of plan) {
      const ev = byId.get(p.stepId);
      rows.push(
        ev
          ? { stepId: ev.stepId, label: ev.label, status: ev.status, detail: ev.detail }
          : { stepId: p.stepId, label: p.label, status: 'pending' }
      );
    }
    for (const ev of seen) {
      if (!plan.some(p => p.stepId === ev.stepId)) {
        rows.push({ stepId: ev.stepId, label: ev.label, status: ev.status, detail: ev.detail });
      }
    }
  } else {
    for (const ev of seen) {
      rows.push({ stepId: ev.stepId, label: ev.label, status: ev.status, detail: ev.detail });
    }
  }
  const done = rows.filter(r => r.status === 'ok').length;

  return (
    <div>
      {plan && (
        <div className="mb-4">
          <p className="text-[11.5px] font-medium text-ink-soft">
            {done} of {rows.length} steps complete
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper-deep">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.round((done / Math.max(rows.length, 1)) * 100)}%` }}
            />
          </div>
        </div>
      )}
      <div className="space-y-0.5">
        {rows.map(s => (
          <div key={s.stepId} className="flex items-start gap-2.5 py-1">
            <StepIcon status={s.status} />
            <div className="min-w-0">
              <p
                className={`text-[13px] ${
                  s.status === 'fail'
                    ? 'font-medium text-red-700'
                    : s.status === 'pending'
                      ? 'text-ink-soft/50'
                      : s.status === 'ok'
                        ? 'text-ink-soft'
                        : 'font-medium text-ink'
                }`}
              >
                {s.label}
                {s.status === 'retry' && (
                  <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent-deep">
                    waiting
                  </span>
                )}
              </p>
              {s.detail && s.status !== 'ok' && (
                <p className="mt-0.5 break-words text-[11.5px] leading-relaxed text-ink-soft">
                  {s.detail}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── split shell: rail (identity + plan) | phase panel ──────────── */

/** Two-panel wizard card: a persistent left rail and a phase panel. */
export function SplitShell({
  rail,
  children,
}: {
  rail: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="mx-auto grid w-full max-w-[900px] overflow-hidden rounded-[20px] border border-line-soft bg-white shadow-[0_12px_40px_-16px_rgba(30,25,18,0.18)] md:grid-cols-[330px_1fr]">
      <aside className="border-b border-line-soft bg-paper px-6 py-6 md:border-b-0 md:border-r">
        {rail}
      </aside>
      <div className="flex min-h-[440px] flex-col p-7">{children}</div>
    </div>
  );
}

type RailRow = { stepId: string; label: string; status: StepEvent['status'] | 'pending' };

function railRows(steps: StepEvent[], plan: { stepId: string; label: string }[]): RailRow[] {
  const byId = new Map(collapseSteps(steps).map(s => [s.stepId, s]));
  const rows: RailRow[] = plan.map(p => {
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

/** The rail body: identity block on top, the always-visible plan below.
 *  Before the run every step shows pending; during it rows light up in
 *  place with a progress bar; when finished the bar turns green. */
export function WizardRail({
  name,
  sub,
  meta,
  planLabel,
  plan,
  steps,
  running,
  finished,
  elapsed = 0,
  danger = false,
}: {
  name: string;
  sub?: string;
  meta?: ReactNode;
  planLabel: string;
  plan: { stepId: string; label: string }[];
  steps: StepEvent[];
  running: boolean;
  finished: boolean;
  elapsed?: number;
  danger?: boolean;
}): ReactElement {
  const rows = railRows(steps, plan);
  const done = rows.filter(r => r.status === 'ok').length;
  const started = running || finished;
  return (
    <div>
      <div className="mb-4 border-b border-line-soft pb-4">
        <p className="font-mono text-[13.5px] font-bold text-ink">{name}</p>
        {sub && <p className="mt-0.5 font-mono text-[11px] text-ink-soft">{sub}</p>}
        {meta && <div className="mt-2.5">{meta}</div>}
      </div>
      {started ? (
        <div className="mb-3">
          <p className="text-[11px] font-semibold text-ink-soft">
            {done} of {rows.length} steps
            {elapsed > 0 && <span className="font-normal"> · {elapsed}s</span>}
          </p>
          <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-paper-deep">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${
                finished ? 'bg-emerald-600' : danger ? 'bg-red-600' : 'bg-accent'
              }`}
              style={{ width: `${Math.round((done / Math.max(rows.length, 1)) * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-soft">
          {planLabel} · {rows.length} steps
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

/** The label of the step currently running (or the last seen one). */
export function currentStepLabel(steps: StepEvent[]): string {
  const rows = collapseSteps(steps);
  const live = [...rows].reverse().find(r => r.status === 'start' || r.status === 'retry');
  return live?.label ?? (rows.length ? rows[rows.length - 1].label : 'Starting');
}

/* ── connect logic shared by every flow ─────────────────────────── */

export interface Connect {
  oauthEnabled: boolean;
  oauthSignedIn: boolean;
  cfEmail: string;
  token: string;
  setToken: (v: string) => void;
  tokenStatus: 'checking' | 'ok' | 'bad' | undefined;
  setTokenStatus: (v: 'checking' | 'ok' | 'bad' | undefined) => void;
  tokenDetail: string | undefined;
  accounts: Account[];
  accountId: string;
  setAccountId: (v: string) => void;
  installs: Install[];
  signInWithCloudflare: () => void;
  oauthError: string;
}

/**
 * Account connection: "Sign in with Cloudflare" (flow-aware return URL) or a
 * pasted API token, auto-verified into accounts + existing installs shortly
 * after typing stops - no extra clicks.
 */
export function useConnect(flow: Flow, sessionId: string | undefined): Connect {
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const [oauthSignedIn, setOauthSignedIn] = useState(false);
  const [cfEmail, setCfEmail] = useState('');
  const [token, setToken] = useState('');
  const [tokenStatus, setTokenStatus] = useState<'checking' | 'ok' | 'bad' | undefined>();
  const [tokenDetail, setTokenDetail] = useState<string | undefined>();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [installs, setInstalls] = useState<Install[]>([]);
  const [oauthError, setOauthError] = useState('');

  useEffect(() => {
    void fetch('/api/config')
      .then(r => r.json() as Promise<{ oauthEnabled?: boolean }>)
      .then(cfg => setOauthEnabled(Boolean(cfg.oauthEnabled)))
      .catch(() => undefined);
  }, []);

  const checkToken = async (t: string, session = sessionId): Promise<void> => {
    if (t.trim().length < 20 || !session) return;
    setTokenStatus('checking');
    try {
      const res = await fetch(`/api/deploy/instance/${session}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: t.trim() }),
      });
      const body = (await res.json()) as {
        data?: Account[];
        email?: string;
        installs?: Install[];
        error?: string;
      };
      if (res.ok && body.data && body.data.length > 0) {
        setAccounts(body.data);
        setAccountId(prev => (body.data!.some(a => a.id === prev) ? prev : body.data![0].id));
        setInstalls(body.installs ?? []);
        if (body.email) setCfEmail(body.email);
        setTokenStatus('ok');
        setTokenDetail(
          body.data.length === 1
            ? `Account: ${body.data[0].name}`
            : `${body.data.length} accounts available`
        );
      } else {
        setTokenStatus('bad');
        setTokenDetail(body.error ?? 'Token check failed');
      }
    } catch {
      setTokenStatus('bad');
      setTokenDetail('Could not reach the server. Check your connection and try again.');
    }
  };

  // Returning from the Cloudflare consent screen: the access token arrives in
  // the URL fragment (never sent to our server); an aborted sign-in arrives as
  // ?oauth_error=. Either way, scrub the URL immediately.
  useEffect(() => {
    if (!sessionId) return;
    const hashToken = new URLSearchParams(window.location.hash.slice(1)).get('cf_token');
    const err = new URLSearchParams(window.location.search).get('oauth_error');
    if (!hashToken && !err) return;
    window.history.replaceState(null, '', `/${flow}?instance=${encodeURIComponent(sessionId)}`);
    if (hashToken) {
      setToken(hashToken);
      setOauthSignedIn(true);
      void checkToken(hashToken, sessionId);
    } else {
      setOauthError(
        err === 'access_denied'
          ? 'Cloudflare sign-in was cancelled. Try again, or paste a token instead.'
          : 'Cloudflare sign-in failed. Try again, or paste a token instead.'
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Auto-verify a pasted token shortly after typing stops - no extra clicks.
  useEffect(() => {
    if (oauthSignedIn || tokenStatus !== undefined || token.trim().length < 20) return;
    const t = window.setTimeout(() => void checkToken(token), 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tokenStatus, oauthSignedIn]);

  return {
    oauthEnabled,
    oauthSignedIn,
    cfEmail,
    token,
    setToken,
    tokenStatus,
    setTokenStatus,
    tokenDetail,
    accounts,
    accountId,
    setAccountId,
    installs,
    signInWithCloudflare: () => {
      window.location.href = `/api/deploy/oauth/start?instance=${encodeURIComponent(
        sessionId ?? ''
      )}&flow=${flow}`;
    },
    oauthError,
  };
}

/** Shared connect screen body: sign-in button / signed-in chip / token field
 *  + account picker. Flow screens compose this inside their own Card. */
export function ConnectSection({
  connect,
  onAccountChange,
}: {
  connect: Connect;
  onAccountChange?: (accountId: string) => void;
}): ReactElement {
  const c = connect;
  const [tokenOpen, setTokenOpen] = useState(false);
  const showToken = !c.oauthSignedIn && (!c.oauthEnabled || tokenOpen || c.token !== '');
  return (
    <div className="space-y-5">
      {c.oauthSignedIn ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-paper px-4 py-3.5">
          <p className="flex items-center gap-2.5 text-[13px] font-semibold text-ink">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100">
              <Check className="h-4 w-4 text-emerald-700" strokeWidth={2.4} />
            </span>
            {c.cfEmail ? `Signed in as ${c.cfEmail}` : 'Signed in with Cloudflare'}
          </p>
          <p className="text-[11.5px] text-ink-soft">
            {c.tokenStatus === 'checking' ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking access…
              </span>
            ) : c.tokenStatus === 'ok' ? (
              c.tokenDetail
            ) : c.tokenStatus === 'bad' ? (
              <span className="text-red-700">{c.tokenDetail}</span>
            ) : null}
          </p>
        </div>
      ) : c.oauthEnabled ? (
        <div>
          <button
            onClick={c.signInWithCloudflare}
            className="flex h-12 w-full cursor-pointer items-center justify-center gap-2.5 rounded-2xl bg-accent text-[14px] font-semibold text-white transition-all hover:-translate-y-px hover:bg-accent-deep hover:shadow-md"
          >
            <CloudGlyph />
            Sign in with Cloudflare
          </button>
          {!showToken ? (
            <p className="mt-2 text-center text-[11.5px] text-ink-soft">
              Approve once on Cloudflare&rsquo;s consent screen and you&rsquo;re back here.{' '}
              <button
                onClick={() => setTokenOpen(true)}
                className="cursor-pointer font-semibold text-ink underline-offset-2 hover:underline"
              >
                Use a token instead
              </button>
            </p>
          ) : (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-soft">
              Opens Cloudflare&rsquo;s consent screen listing every permission. Approve once and
              you&rsquo;re back here.
            </p>
          )}
        </div>
      ) : null}
      {showToken && (
        <TokenField
          id="installer-token"
          label="Cloudflare API token"
          help={
            <>
              Lets Postey act on the Workers, database, queues, and bucket in your account. The
              pre-filled link selects most permissions - add{' '}
              <strong className="text-ink">Email Sending: Edit</strong> by hand before creating.
            </>
          }
          linkLabel="Create token (pre-filled)"
          linkUrl={INSTALLER_TOKEN_URL}
          value={c.token}
          onChange={v => {
            c.setToken(v);
            c.setTokenStatus(undefined);
          }}
          status={c.tokenStatus}
          statusDetail={c.tokenDetail}
          errorHelp="Recreate it with the pre-filled link, keep the pre-selected permissions, add Email Sending: Edit, then Create Token and copy the full value."
        />
      )}
      {c.accounts.length > 1 && (
        <SelectField
          id="wizard-account"
          label="Cloudflare account"
          value={c.accountId}
          onChange={e => {
            c.setAccountId(e.target.value);
            onAccountChange?.(e.target.value);
          }}
        >
          {c.accounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
      )}
    </div>
  );
}

function CloudGlyph(): ReactElement {
  // lucide Cloud, inlined to keep this module's imports minimal.
  return (
    <svg
      className="h-[18px] w-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}
