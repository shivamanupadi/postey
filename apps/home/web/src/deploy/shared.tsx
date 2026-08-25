/** Shared pieces for the deploy/update/destroy wizard pages. */
import type { ReactElement, ReactNode } from 'react';

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

/* ── UI atoms (Postey paper theme) ───────────────────────────────── */

export function Panel({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="rounded-2xl border border-line bg-paper p-6">
      <h2 className="font-display text-xl font-semibold text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-6 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50 ${
        danger ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent-deep'
      }`}
    >
      {children}
    </button>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): ReactElement {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-soft/60 focus:border-accent ${props.className ?? ''}`}
    />
  );
}

export function ErrorNote({ error }: { error: string | null }): ReactElement | null {
  if (!error) return null;
  return (
    <p className="mt-3 rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-700">
      {error}
    </p>
  );
}

/** Collapse the raw event log into one row per step (latest status wins). */
export function collapseSteps(steps: StepEvent[]): StepEvent[] {
  const rows: StepEvent[] = [];
  for (const ev of steps) {
    const existing = rows.findIndex(s => s.stepId === ev.stepId);
    if (existing >= 0) rows[existing] = ev;
    else rows.push(ev);
  }
  return rows;
}

export function StepList({ steps }: { steps: StepEvent[] }): ReactElement {
  return (
    <ol className="space-y-2">
      {collapseSteps(steps).map(s => (
        <li key={s.stepId} className="flex items-start gap-3 text-sm">
          <span className="mt-0.5 w-5 text-center">
            {s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : '·'}
          </span>
          <div className="min-w-0">
            <p className={s.status === 'fail' ? 'font-medium text-red-700' : 'text-ink'}>
              {s.label}
              {s.status === 'start' || s.status === 'retry' ? '…' : ''}
            </p>
            {s.detail && <p className="mt-0.5 break-words text-xs text-ink-soft">{s.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Connect panel: OAuth button (when enabled) + token paste fallback. */
export function ConnectPanel({
  instance,
  flow,
  oauthEnabled,
  apiToken,
  setApiToken,
  onContinue,
  error,
}: {
  instance: string | undefined;
  flow: 'update' | 'destroy';
  oauthEnabled: boolean;
  apiToken: string;
  setApiToken: (v: string) => void;
  onContinue: () => void;
  error: string | null;
}): ReactElement {
  return (
    <Panel title="1 · Connect Cloudflare">
      {oauthEnabled && (
        <div className="mb-5">
          <a
            href={`/api/deploy/oauth/start?instance=${encodeURIComponent(instance ?? '')}&flow=${flow}`}
            className="inline-block rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-deep"
          >
            Sign in with Cloudflare →
          </a>
          <p className="mt-2 text-xs text-ink-soft">
            One click: authorize on the Cloudflare dashboard and come straight back. Or paste an
            API token below.
          </p>
          <div className="mt-4 border-t border-line" />
        </div>
      )}
      <div className="flex gap-3">
        <TextInput
          type="password"
          placeholder="Cloudflare API token"
          value={apiToken}
          onChange={e => setApiToken(e.target.value)}
        />
        <PrimaryButton onClick={onContinue} disabled={apiToken.length < 20}>
          Continue
        </PrimaryButton>
      </div>
      <ErrorNote error={error} />
    </Panel>
  );
}
