/**
 * Receiving verification block - the MX (Email Routing) DNS check and the
 * catch-all self-probe - shared by the Inbox setup card and the Domains
 * drawer so routing health stays visible after setup, not just before it.
 */
import { useState, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtTime } from '@/lib/api';
import { Button, ErrorNote } from '@/lib/ui';

export interface ReceivingStatus {
  domain: string;
  dns: { mx: boolean; dkim: boolean };
  probe: { status: 'none' | 'pending' | 'verified'; sent_at?: number; received_at?: number };
}

/** A pending probe should land in seconds; after this it reads as a miss. */
const PROBE_WAIT_MS = 120_000;

export function CheckRow({
  ok,
  label,
  detail,
}: {
  ok: boolean | null;
  label: string;
  detail?: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-[12.5px] text-ink">
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
          ok === null ? 'bg-paper text-ink-soft' : ok ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'
        }`}
      >
        {ok === null ? '·' : ok ? '✓' : '!'}
      </span>
      {label}
      <span className="ml-auto font-mono text-[10.5px] text-ink-soft">
        {detail ?? (ok === null ? 'checking…' : ok ? 'found' : 'not found yet')}
      </span>
    </div>
  );
}

export function ReceivingChecks({
  domainId,
  active,
}: {
  domainId: string;
  /** Probes are real sends from the domain - only active domains can send one. */
  active: boolean;
}): ReactElement {
  const qc = useQueryClient();
  const [started, setStarted] = useState(false);
  const receiving = useQuery({
    queryKey: ['receiving', domainId],
    queryFn: () => api.get<ReceivingStatus>(`/api/inbox/receiving/${domainId}`),
    /* Poll while a probe is out: quickly during the normal delivery window,
     * then keep listening slowly - a probe that lands after the user fixes
     * the catch-all should still flip the card to verified. */
    refetchInterval: q => {
      const p = q.state.data?.probe;
      if (p?.status !== 'pending') return false;
      return Date.now() - (p.sent_at ?? 0) < PROBE_WAIT_MS ? 4000 : 15_000;
    },
    // Users tab away to Cloudflare to fix the catch-all mid-probe; the
    // verified stamp should be waiting when they come back.
    refetchIntervalInBackground: true,
  });
  const probe = useMutation({
    mutationFn: () => api.post(`/api/inbox/receiving/${domainId}/probe`),
    onSuccess: () => {
      setStarted(true);
      void qc.invalidateQueries({ queryKey: ['receiving', domainId] });
    },
  });

  const r = receiving.data;
  const p = r?.probe;
  const waiting = p?.status === 'pending' && Date.now() - (p.sent_at ?? 0) < PROBE_WAIT_MS;
  const probeOk: boolean | null =
    p?.status === 'verified' ? true : p?.status === 'pending' && !waiting ? false : null;
  const probeDetail =
    p?.status === 'verified'
      ? `verified ${fmtTime(p.received_at)}`
      : waiting
        ? 'probe in flight…'
        : p?.status === 'pending'
          ? started
            ? 'probe not received'
            : 'earlier probe never arrived'
          : 'not verified yet';

  return (
    <div>
      <div className="divide-y divide-[#efe8dc]">
        <CheckRow
          ok={r ? r.dns.mx : null}
          label="MX → Cloudflare (Email Routing enabled)"
          detail={r ? (r.dns.mx ? 'found' : 'not found yet') : undefined}
        />
        <CheckRow ok={probeOk} label="Catch-all delivers to the inbound worker" detail={probeDetail} />
      </div>
      <ErrorNote error={probe.error} />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[10.5px] leading-relaxed text-ink-soft">
          {active
            ? 'The probe is one real email the instance sends itself - if it lands, the whole MX → catch-all → worker path is proven.'
            : 'Activate the domain for sending first - the probe is a real send from it.'}
        </span>
        <Button
          variant="ghost"
          onClick={() => probe.mutate()}
          disabled={!active || probe.isPending || waiting}
        >
          {waiting
            ? 'Waiting for probe…'
            : p?.status === 'verified'
              ? 'Re-verify'
              : p?.status === 'pending'
                ? 'Send probe again'
                : 'Send test probe'}
        </Button>
      </div>
    </div>
  );
}
