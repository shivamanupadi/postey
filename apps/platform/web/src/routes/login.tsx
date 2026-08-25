import { useState, type ReactElement, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, ErrorNote, Field, Input } from '@/lib/ui';

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
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <img src="/logo.svg" alt="" className="h-9 w-9" />
          <span className="font-display text-2xl font-semibold">
            postey<span className="text-accent">.</span>
          </span>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-white/60 p-6">
          <h1 className="font-display text-xl font-semibold">
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
          <Button type="submit" disabled={busy}>
            {busy ? 'Working…' : claiming ? 'Claim & sign in' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
