import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MailOpen } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import { Button, Dropdown, ErrorNote, Field, Input, Modal } from '@/lib/ui';
import type { InboxAddressRow } from './__root';

interface InboxSearch {
  addr?: string;
  msg?: string;
  new?: boolean;
}

export const Route = createFileRoute('/inbox')({
  validateSearch: (s: Record<string, unknown>): InboxSearch => ({
    ...(typeof s.addr === 'string' ? { addr: s.addr } : {}),
    ...(typeof s.msg === 'string' ? { msg: s.msg } : {}),
    ...(s.new ? { new: true } : {}),
  }),
  component: InboxPage,
});

interface MessageRow {
  id: string;
  address_id: string;
  from_email: string;
  from_name: string | null;
  to_email: string;
  subject: string;
  snippet: string | null;
  reply_to_message_id: string | null;
  read_at: number | null;
  created_at: number;
}

interface MessageDetail extends MessageRow {
  html: string | null;
  text: string | null;
  parent: {
    id: string;
    subject: string;
    status: string;
    from_email: string;
    to_json: string;
    created_at: number;
    sent_at: number | null;
  } | null;
  our_replies: { id: string; subject: string; status: string; created_at: number }[];
}

function InboxPage(): ReactElement {
  const { addr, msg, new: creating } = Route.useSearch();
  const navigate = useNavigate({ from: '/inbox' });
  const qc = useQueryClient();

  const addresses = useQuery({
    queryKey: ['inbox-addresses'],
    queryFn: () => api.get<InboxAddressRow[]>('/api/inbox/addresses'),
    staleTime: 30_000,
  });
  const messages = useQuery({
    queryKey: ['inbox-messages', addr ?? 'all'],
    queryFn: () =>
      api.get<MessageRow[]>(`/api/inbox/messages${addr ? `?address_id=${addr}` : ''}`),
    staleTime: 10_000,
  });
  const detail = useQuery({
    queryKey: ['inbox-message', msg],
    queryFn: () => api.get<MessageDetail>(`/api/inbox/messages/${msg}`),
    enabled: Boolean(msg),
  });
  // Opening a message marks it read server-side - refresh the unread badges.
  useEffect(() => {
    if (detail.data && !detail.data.read_at) return;
    if (detail.data) {
      void qc.invalidateQueries({ queryKey: ['inbox-addresses'] });
      void qc.invalidateQueries({ queryKey: ['inbox-messages'] });
    }
  }, [detail.data, qc]);

  const selectedAddress = addresses.data?.find(a => a.id === addr);
  const title = selectedAddress
    ? `${selectedAddress.local_part}@${selectedAddress.domain_name}`
    : 'All mail';

  return (
    <div className="flex h-[calc(100vh-72px)] gap-0 overflow-hidden rounded-2xl border border-line-soft bg-card shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
      {/* message list */}
      <div className="flex w-[320px] shrink-0 flex-col border-r border-line-soft">
        <div className="border-b border-line-soft px-4 py-3">
          <h1 className="truncate font-mono text-[13.5px] font-semibold text-ink">{title}</h1>
          <p className="mt-0.5 text-[11px] text-ink-soft">
            {messages.data
              ? `${messages.data.length} message${messages.data.length === 1 ? '' : 's'}`
              : 'Loading…'}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {messages.data?.length ? (
            messages.data.map(m => {
              const active = m.id === msg;
              const unread = !m.read_at;
              return (
                <Link
                  key={m.id}
                  to="/inbox"
                  search={{ ...(addr ? { addr } : {}), msg: m.id }}
                  className={`block border-b border-[#efe9df] px-4 py-3 transition ${
                    active ? 'border-l-[3px] border-l-accent bg-accent-soft pl-[13px]' : 'hover:bg-paper/60'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="min-w-0 truncate text-[13px] font-semibold text-ink">
                      {unread && (
                        <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-[2px]" />
                      )}
                      {m.from_name || m.from_email}
                    </p>
                    <span className="shrink-0 text-[10.5px] text-ink-soft">
                      {fmtTime(m.created_at)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-ink">{m.subject}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-ink-soft">
                    → {m.to_email.split('@')[0]}@ ·{' '}
                    {m.reply_to_message_id
                      ? `replies to ${m.reply_to_message_id.slice(0, 12)}…`
                      : 'new thread'}
                  </p>
                </Link>
              );
            })
          ) : (
            <div className="px-4 py-8 text-center text-xs leading-relaxed text-ink-soft">
              {messages.isLoading
                ? 'Loading…'
                : addresses.data?.length
                  ? 'No mail yet. Replies to your sends land here once Email Routing points at the inbound worker.'
                  : 'Create an address to start receiving.'}
            </div>
          )}
        </div>
      </div>

      {/* thread */}
      <div className="min-w-0 flex-1 overflow-y-auto bg-paper px-6 py-5">
        {msg && detail.data ? (
          <Thread d={detail.data} />
        ) : addresses.data && addresses.data.length === 0 && !addresses.isLoading ? (
          <SetupCard />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-ink-soft">
              <MailOpen className="mx-auto h-8 w-8 text-ink-soft/40" />
              <p className="mt-3 text-sm">Select a message to read the thread.</p>
            </div>
          </div>
        )}
      </div>

      {creating && <NewAddressModal onClose={() => void navigate({ search: prev => ({ ...prev, new: undefined }) })} />}
    </div>
  );
}

/* ── thread view ─────────────────────────────────────────────────── */

function Thread({ d }: { d: MessageDetail }): ReactElement {
  const qc = useQueryClient();
  const [replyText, setReplyText] = useState('');
  const reply = useMutation({
    mutationFn: () => api.post(`/api/inbox/messages/${d.id}/reply`, { text: replyText }),
    onSuccess: () => {
      setReplyText('');
      void qc.invalidateQueries({ queryKey: ['inbox-message', d.id] });
    },
  });
  const suppress = useMutation({
    mutationFn: () => api.post('/api/suppressions', { address: d.from_email, reason: 'manual' }),
  });

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="min-w-0 text-[17px] font-semibold text-ink">{d.subject}</h2>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={() => suppress.mutate()} disabled={suppress.isPending || suppress.isSuccess}>
            {suppress.isSuccess ? 'Suppressed ✓' : 'Suppress sender'}
          </Button>
        </div>
      </div>
      <p className="mt-1 font-mono text-[11px] text-ink-soft">
        thread with {d.from_email} · via {d.to_email}
      </p>
      <ErrorNote error={suppress.error} />

      <div className="mt-5 space-y-3">
        {d.parent && (
          <div className="max-w-[540px] rounded-2xl border border-line-soft bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-3 text-[10.5px] text-ink-soft">
              <span>
                <b className="font-semibold text-ink">{d.parent.from_email}</b> →{' '}
                {JSON.parse(d.parent.to_json).join(', ')}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-ok-soft px-2 py-px font-bold text-ok">
                  {d.parent.status} · {fmtTime(d.parent.sent_at ?? d.parent.created_at)}
                </span>
                <Link
                  to="/emails/$id"
                  params={{ id: d.parent.id }}
                  className="flex items-center gap-1 font-semibold text-accent-deep hover:underline"
                >
                  email log <ExternalLink className="h-3 w-3" />
                </Link>
              </span>
            </div>
            <p className="mt-2 text-[12.5px] text-ink">{d.parent.subject}</p>
          </div>
        )}

        <div className="ml-10 max-w-[540px] rounded-2xl border border-accent/25 bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-[10.5px] text-ink-soft">
            <span>
              <b className="font-semibold text-ink">{d.from_name || d.from_email}</b> →{' '}
              {d.to_email}
            </span>
            <span className="rounded-full bg-accent-soft px-2 py-px font-bold text-accent-deep">
              received · {fmtTime(d.created_at)}
            </span>
          </div>
          {d.html ? (
            <iframe
              title="message"
              sandbox=""
              srcDoc={d.html}
              className="mt-2 h-[320px] w-full rounded-lg border border-line-soft bg-white"
            />
          ) : (
            <pre className="mt-2 whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-ink">
              {d.text ?? '(empty message)'}
            </pre>
          )}
        </div>

        {d.our_replies.map(r => (
          <div key={r.id} className="max-w-[540px] rounded-2xl border border-line-soft bg-card px-4 py-2.5">
            <div className="flex items-center justify-between gap-3 text-[10.5px] text-ink-soft">
              <span>
                you replied · <b className="font-semibold text-ink">{r.subject}</b>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-ok-soft px-2 py-px font-bold text-ok">
                  {r.status} · {fmtTime(r.created_at)}
                </span>
                <Link
                  to="/emails/$id"
                  params={{ id: r.id }}
                  className="flex items-center gap-1 font-semibold text-accent-deep hover:underline"
                >
                  email log <ExternalLink className="h-3 w-3" />
                </Link>
              </span>
            </div>
          </div>
        ))}

        {/* composer */}
        <div className="ml-10 max-w-[540px] rounded-2xl border border-line bg-card px-4 py-3">
          <p className="font-mono text-[10.5px] text-ink-soft">
            replying as <b className="text-ink">{d.to_email}</b> · lands in the email log like any
            send
          </p>
          <textarea
            className="mt-2 min-h-[88px] w-full resize-y rounded-[10px] border border-line bg-paper px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none transition placeholder:text-ink-soft/45 focus:border-accent focus:ring-2 focus:ring-accent/15"
            placeholder={`Reply to ${d.from_name || d.from_email}…`}
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
          />
          <ErrorNote error={reply.error} />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10.5px] text-ink-soft">
              delivered by the send pipeline · plain text
            </span>
            <Button onClick={() => reply.mutate()} disabled={reply.isPending || !replyText.trim()}>
              {reply.isPending ? 'Sending…' : 'Send reply'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── first-run setup ─────────────────────────────────────────────── */

function SetupCard(): ReactElement {
  const navigate = useNavigate({ from: '/inbox' });
  return (
    <div className="mx-auto max-w-xl pt-10">
      <h2 className="text-[17px] font-semibold text-ink">Turn on receiving</h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
        Postey never changes how your domain's mail flows on its own - routing inbound email is a
        one-time, deliberate step in Cloudflare:
      </p>
      <ol className="mt-4 list-decimal space-y-2.5 pl-5 text-[13px] leading-relaxed text-ink">
        <li>
          Open{' '}
          <a
            className="font-semibold text-accent-deep underline"
            href="https://dash.cloudflare.com/?to=/:account/:zone/email/routing"
            target="_blank"
            rel="noreferrer"
          >
            Email Routing
          </a>{' '}
          for your sending domain's zone and enable it (Cloudflare adds the MX records).
        </li>
        <li>
          Under <b>Routing rules</b>, set the <b>catch-all</b> action to{' '}
          <b>Send to a Worker</b> → your <code className="font-mono text-xs">…-inbound</code>{' '}
          worker.
        </li>
        <li>
          Create your first address below - unknown addresses keep bouncing, so the catch-all
          never becomes a spam trap.
        </li>
      </ol>
      <div className="mt-6">
        <Button onClick={() => void navigate({ search: prev => ({ ...prev, new: true }) })}>
          Create your first address
        </Button>
      </div>
    </div>
  );
}

/* ── new address ─────────────────────────────────────────────────── */

function NewAddressModal({ onClose }: { onClose: () => void }): ReactElement {
  const qc = useQueryClient();
  const navigate = useNavigate({ from: '/inbox' });
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string; status: string }[]>('/api/domains'),
  });
  const active = domains.data?.filter(d => d.status === 'active') ?? [];
  const [local, setLocal] = useState('');
  const [domainId, setDomainId] = useState('');
  const chosen = domainId || active[0]?.id || '';

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; address: string }>('/api/inbox/addresses', {
        domain_id: chosen,
        local_part: local,
      }),
    onSuccess: data => {
      void qc.invalidateQueries({ queryKey: ['inbox-addresses'] });
      void navigate({ search: { addr: data.id } });
    },
  });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (local && chosen) create.mutate();
  };

  return (
    <Modal
      title="New inbox address"
      sub="Instant - the catch-all already delivers everything; this registers what to keep."
      onClose={onClose}
    >
      <form onSubmit={submit} className="mt-4 space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Address">
              <Input
                autoFocus
                placeholder="support"
                value={local}
                onChange={e => setLocal(e.target.value)}
              />
            </Field>
          </div>
          <span className="pb-2.5 text-sm text-ink-soft">@</span>
          <div className="flex-1">
            <Field label="Domain">
              <Dropdown
                full
                value={chosen}
                onChange={setDomainId}
                options={active.map(d => ({ value: d.id, label: d.name }))}
              />
            </Field>
          </div>
        </div>
        {!active.length && (
          <p className="rounded-[10px] bg-warn-soft px-3.5 py-2.5 text-xs leading-relaxed text-warn">
            No active domain - verify &amp; activate one on the Domains page first.
          </p>
        )}
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !local || !chosen}>
            {create.isPending ? 'Creating…' : 'Create address'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
