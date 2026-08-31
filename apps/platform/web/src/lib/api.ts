export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'same-origin',
  });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  return (body?.data ?? body) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const fmtTime = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleString() : '-';

export const STATUS_COLORS: Record<string, string> = {
  delivered: 'bg-ok-soft text-ok',
  sent: 'bg-ok-soft text-ok',
  queued: 'bg-warn-soft text-warn',
  scheduled: 'bg-warn-soft text-warn',
  sending: 'bg-warn-soft text-warn',
  deferred: 'bg-warn-soft text-warn',
  partial: 'bg-warn-soft text-warn',
  bounced: 'bg-bad-soft text-bad',
  complained: 'bg-bad-soft text-bad',
  rejected: 'bg-bad-soft text-bad',
  failed: 'bg-bad-soft text-bad',
  suppressed: 'bg-ink/10 text-ink-soft',
  canceled: 'bg-ink/10 text-ink-soft',
  active: 'bg-ok/10 text-ok',
  pending: 'bg-accent-soft text-accent-deep',
};
