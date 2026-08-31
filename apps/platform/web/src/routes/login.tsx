import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ErrorNote, Field, Input } from '@/lib/ui';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage(): ReactElement {
  const claimStatus = useQuery({
    queryKey: ['claim-status'],
    queryFn: async () => {
      const res = await fetch('/api/claim-status');
      return (await res.json()) as { claimed: boolean; needsCode: boolean };
    },
  });
  const claiming = claimStatus.data ? !claimStatus.data.claimed : false;
  // The wizard hands the claim code over in the URL fragment (never logged).
  const fragmentCode = new URLSearchParams(window.location.hash.slice(1)).get('claim') ?? '';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState(fragmentCode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(claiming ? '/api/auth/claim' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(claiming ? { email, password, code: code || undefined } : { email, password }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Request failed');
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-5">
      {/* dot grid, matching the deploy wizard */}
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
      <div className="relative w-full max-w-sm">
        <div className="mb-7 flex items-center justify-center gap-2.5">
          <img src="/logo.svg" alt="" className="h-9 w-9" />
          <span className="text-[22px] font-semibold tracking-tight">
            postey<span className="text-accent">.</span>
          </span>
        </div>
        <form
          onSubmit={submit}
          className="space-y-4 rounded-[20px] border border-line-soft bg-white p-7 shadow-[0_12px_40px_-16px_rgba(30,25,18,0.18)]"
        >
          <h1 className="text-[17px] font-semibold">
            {claiming ? 'Claim this instance' : 'Sign in'}
          </h1>
          {claiming && (
            <p className="text-xs leading-relaxed text-ink-soft">
              First sign-up on a fresh install. This account becomes the instance operator.
            </p>
          )}
          {claiming && claimStatus.data?.needsCode && (
            <Field label="Claim code">
              <Input value={code} onChange={e => setCode(e.target.value)} placeholder="from the deploy wizard" />
            </Field>
          )}
          <Field label="Email">
            <Input type="email" required value={email} onChange={e => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={claiming ? 'at least 10 characters' : undefined}
            />
          </Field>
          <ErrorNote error={error} />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-[10px] bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? 'Working…' : claiming ? 'Claim & sign in' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
