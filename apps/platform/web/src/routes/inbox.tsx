import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailOpen, Paperclip, SquarePen, Trash2, X } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import { EmailBody } from '@/lib/email-view';
import { ReceivingChecks } from '@/lib/receiving';
import { Button, ConfirmDialog, Dropdown, ErrorNote, Field, Input, Modal } from '@/lib/ui';
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
  status: string | null;
  direction: 'inbound' | 'outbound';
}

interface InboxAttachment {
  index: number;
  filename: string;
  type: string;
  size: number;
  disposition: string;
  content_id: string | null;
}

interface ConvMessage {
  kind: 'inbound' | 'outbound';
  id: string;
  from: string;
  from_name?: string | null;
  to: string[];
  subject: string;
  status?: string;
  text: string | null;
  html: string | null;
  attachments: InboxAttachment[];
  read_at?: number | null;
  created_at: number;
}

interface Conversation {
  seed: string;
  subject: string;
  our_address: string | null;
  address_id: string | null;
  counterpart: string | null;
  had_unread: boolean;
  messages: ConvMessage[];
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
    queryKey: ['inbox-conversation', msg],
    queryFn: () => api.get<Conversation>(`/api/inbox/conversations/${msg}`),
    enabled: Boolean(msg),
  });
  // Opening a conversation marks its mail read server-side - refresh badges.
  useEffect(() => {
    if (detail.data?.had_unread) {
      void qc.invalidateQueries({ queryKey: ['inbox-addresses'] });
      void qc.invalidateQueries({ queryKey: ['inbox-messages'] });
    }
  }, [detail.data, qc]);

  const selectedAddress = addresses.data?.find(a => a.id === addr);
  const title = selectedAddress
    ? `${selectedAddress.local_part}@${selectedAddress.domain_name}`
    : 'All mail';

  const [removing, setRemoving] = useState(false);
  const [composing, setComposing] = useState(false);
  const removeAddress = useMutation({
    mutationFn: () => api.delete(`/api/inbox/addresses/${addr}`),
    onSuccess: () => {
      setRemoving(false);
      void qc.invalidateQueries({ queryKey: ['inbox-addresses'] });
      void qc.invalidateQueries({ queryKey: ['inbox-messages'] });
      void navigate({ search: {} });
    },
  });

  return (
    <div className="flex h-[calc(100vh-72px)] gap-0 overflow-hidden rounded-2xl border border-line-soft bg-card shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
      {/* message list */}
      <div className="flex w-[320px] shrink-0 flex-col border-r border-line-soft">
        <div className="flex items-start justify-between gap-2 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate font-mono text-[13.5px] font-semibold text-ink">{title}</h1>
            <p className="mt-0.5 text-[11px] text-ink-soft">
              {messages.data
                ? `${messages.data.length} message${messages.data.length === 1 ? '' : 's'}`
                : 'Loading…'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {(addresses.data?.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setComposing(true)}
                className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[11.5px] font-semibold text-white transition hover:bg-accent-deep"
              >
                <SquarePen className="h-3 w-3" /> New email
              </button>
            )}
            {selectedAddress && (
              <button
                type="button"
                aria-label={`Remove ${title}`}
                onClick={() => setRemoving(true)}
                className="rounded-lg p-1.5 text-ink-soft/70 transition hover:bg-bad-soft hover:text-bad"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {messages.data?.length ? (
            messages.data.map(m => {
              const active = m.id === msg;
              const sent = m.direction === 'outbound';
              const unread = !sent && !m.read_at;
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
                    <p
                      className={`flex min-w-0 items-baseline gap-1.5 text-[13px] text-ink ${
                        unread ? 'font-bold' : 'font-medium'
                      }`}
                    >
                      {unread && (
                        <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent" />
                      )}
                      {sent ? (
                        <>
                          <span className="min-w-0 truncate">
                            <span className="text-ink-soft">→ </span>
                            {m.to_email}
                          </span>
                          <span className="shrink-0 rounded-full bg-ok-soft px-1.5 py-px font-mono text-[9.5px] font-bold text-ok">
                            sent
                          </span>
                        </>
                      ) : (
                        <span className="min-w-0 truncate">{m.from_name || m.from_email}</span>
                      )}
                    </p>
                    <span className="shrink-0 text-[10.5px] text-ink-soft">
                      {fmtTime(m.created_at)}
                    </span>
                  </div>
                  <p
                    className={`mt-0.5 truncate text-[12.5px] text-ink ${
                      unread ? 'font-semibold' : ''
                    }`}
                  >
                    {m.subject}
                  </p>
                  {m.snippet && (
                    <p className="mt-0.5 truncate text-[11.5px] text-ink-soft">{m.snippet}</p>
                  )}
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
      <div className="min-w-0 flex-1 overflow-y-auto bg-card px-8 py-6">
        {msg && detail.data ? (
          <ConversationView key={msg} d={detail.data} />
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

      {composing && addresses.data && (
        <Composer
          addresses={addresses.data}
          preferredId={addr}
          onClose={() => setComposing(false)}
        />
      )}

      {removing && selectedAddress && (
        <ConfirmDialog
          title={`Remove ${title}?`}
          sub="This cannot be undone."
          confirmLabel="Remove address"
          busy={removeAddress.isPending}
          onConfirm={() => removeAddress.mutate()}
          onCancel={() => setRemoving(false)}
        >
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            Mail to this address bounces again with "not monitored", and its{' '}
            {selectedAddress.message_count} stored message
            {Number(selectedAddress.message_count) === 1 ? '' : 's'} (bodies included) are deleted.
            Replies you sent stay in the email log.
          </p>
          <ErrorNote error={removeAddress.error} />
        </ConfirmDialog>
      )}
    </div>
  );
}

/* ── composer ────────────────────────────────────────────────────────
 * A fresh send from an inbox address, no thread history. Gmail-style
 * floating card: borderless stacked fields split by hairlines, dark
 * title bar, body filling the rest. Replies thread back automatically. */

function Composer({
  addresses,
  preferredId,
  onClose,
}: {
  addresses: InboxAddressRow[];
  preferredId?: string;
  onClose: () => void;
}): ReactElement {
  const [addressId, setAddressId] = useState(
    preferredId && addresses.some(a => a.id === preferredId) ? preferredId : (addresses[0]?.id ?? '')
  );
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<
    { filename: string; content: string; content_type: string; size: number }[]
  >([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null): void => {
    if (!list) return;
    setFileError(null);
    const current = files.reduce((sum, f) => sum + f.size, 0);
    let running = current;
    void Promise.all(
      [...list].map(
        f =>
          new Promise<{ filename: string; content: string; content_type: string; size: number } | null>(
            resolve => {
              running += f.size;
              if (running > 4 * 1024 * 1024) {
                setFileError('Attachments are limited to 4 MiB total');
                resolve(null);
                return;
              }
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  filename: f.name,
                  content: String(reader.result).split(',')[1] ?? '',
                  content_type: f.type || 'application/octet-stream',
                  size: f.size,
                });
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(f);
            }
          )
      )
    ).then(read => setFiles(prev => [...prev, ...read.filter((f): f is NonNullable<typeof f> => f !== null)]));
    if (fileInput.current) fileInput.current.value = '';
  };

  const send = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/inbox/compose', {
        address_id: addressId,
        to: to.split(',').map(s => s.trim()).filter(Boolean),
        subject: subject.trim(),
        text,
        ...(files.length
          ? { attachments: files.map(({ size: _s, ...rest }) => rest) }
          : {}),
      }),
    onSuccess: onClose,
  });
  const ready = addressId && to.trim() && subject.trim() && text.trim();
  const fieldRow = 'flex items-center gap-3 border-b border-line-soft px-4 py-2';
  const label = 'w-12 shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-soft';
  const input =
    'w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-soft/45';

  return (
    <div className="fixed bottom-0 right-6 z-40 flex w-[460px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-t-2xl border border-b-0 border-line bg-card shadow-[0_-12px_48px_-12px_rgba(30,25,18,0.4)]">
      <div className="flex items-center justify-between bg-ink-deep px-4 py-2.5">
        <span className="text-[13px] font-semibold text-cream">New email</span>
        <button
          type="button"
          aria-label="Close composer"
          onClick={onClose}
          className="rounded p-1 text-cream/60 transition hover:text-cream"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className={fieldRow}>
        <span className={label}>From</span>
        <select
          value={addressId}
          onChange={e => setAddressId(e.target.value)}
          className="w-full appearance-none bg-transparent font-mono text-[12.5px] text-ink outline-none"
        >
          {addresses.map(a => (
            <option key={a.id} value={a.id}>
              {a.local_part}@{a.domain_name}
            </option>
          ))}
        </select>
      </div>
      <div className={fieldRow}>
        <span className={label}>To</span>
        <input
          autoFocus
          type="text"
          className={input}
          placeholder="one@example.com, another@example.com"
          value={to}
          onChange={e => setTo(e.target.value)}
        />
      </div>
      <div className={fieldRow}>
        <span className={label}>Subject</span>
        <input
          type="text"
          className={input}
          placeholder="Subject"
          value={subject}
          onChange={e => setSubject(e.target.value)}
        />
      </div>

      <textarea
        className="h-[220px] w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-soft/45"
        placeholder="Write your email…"
        value={text}
        onChange={e => setText(e.target.value)}
      />

      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line-soft px-4 py-2">
          {files.map((f, i) => (
            <span
              key={`${f.filename}-${i}`}
              className="flex max-w-full items-center gap-1.5 rounded-lg border border-line-soft bg-paper px-2.5 py-1 text-[11.5px]"
            >
              <Paperclip className="h-3 w-3 shrink-0 text-ink-soft" />
              <span className="max-w-44 truncate font-semibold text-ink">{f.filename}</span>
              <span className="font-mono text-[10px] text-ink-soft">{fmtSize(f.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${f.filename}`}
                onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                className="rounded-full p-0.5 text-ink-soft transition hover:bg-paper-deep hover:text-ink"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="border-t border-line-soft px-4 py-2.5">
        {fileError && <p className="mb-1.5 text-[11px] font-semibold text-bad">{fileError}</p>}
        <ErrorNote error={send.error} />
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={e => addFiles(e.target.files)}
            />
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files"
              onClick={() => fileInput.current?.click()}
              className="rounded-lg p-1.5 text-ink-soft transition hover:bg-paper hover:text-ink"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <span className="text-[10.5px] leading-relaxed text-ink-soft">
              lands in the email log · replies thread back here
            </span>
          </span>
          <Button onClick={() => send.mutate()} disabled={send.isPending || !ready}>
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── thread view ─────────────────────────────────────────────────── */

const fmtSize = (bytes: number): string =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const snippetOf = (m: ConvMessage): string =>
  (m.text ?? (m.html ? m.html.replace(/<[^>]+>/g, ' ') : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140) || '(no content)';

const statusTone = (s?: string): string =>
  s === 'failed' || s === 'bounced' || s === 'complained'
    ? 'bg-bad-soft text-bad'
    : s === 'sent' || s === 'delivered'
      ? 'bg-ok-soft text-ok'
      : 'bg-warn-soft text-warn';

/** Attachment cards + cid map for one message, routed by direction. */
const attachmentUrl = (m: ConvMessage, index: number): string =>
  m.kind === 'inbound'
    ? `/api/inbox/messages/${m.id}/attachments/${index}`
    : `/api/messages/${m.id}/attachments/${index}`;

function Message({ m, ourSide }: { m: ConvMessage; ourSide: boolean }): ReactElement {
  const cidMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of m.attachments) {
      if (a.disposition === 'inline' && a.content_id) map[a.content_id] = attachmentUrl(m, a.index);
    }
    return map;
  }, [m]);
  const files = m.attachments.filter(a => !(a.disposition === 'inline' && a.content_id));
  const who = ourSide ? `you · ${m.from.split('@')[0]}@` : m.from_name || m.from;

  return (
    <div className="overflow-hidden rounded-[14px] border border-line-soft bg-white">
      <div className="flex items-baseline justify-between gap-3 px-4.5 pt-3.5">
        <p className="min-w-0 truncate text-[13.5px] text-ink">
          <span className={ourSide ? 'font-medium text-ink-soft' : 'font-semibold'}>{who}</span>{' '}
          {!ourSide && m.from_name && <span className="text-ink-soft">&lt;{m.from}&gt;</span>}
          {ourSide && m.status && (
            <span
              className={`ml-2 rounded-full px-2 py-px align-[1px] font-mono text-[9.5px] font-bold ${statusTone(m.status)}`}
            >
              {m.status}
            </span>
          )}
        </p>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-soft">
          {fmtTime(m.created_at)}
        </span>
      </div>
      <p className="px-4.5 pt-0.5 text-[11.5px] text-ink-soft">to {m.to.join(', ')}</p>
      <div className="px-4.5 py-3.5">
        <EmailBody html={m.html} text={m.text} cidMap={cidMap} />
      </div>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4.5 pb-4">
          {files.map(a => (
            <a
              key={a.index}
              href={attachmentUrl(m, a.index)}
              download={a.filename}
              className="flex items-center gap-2 rounded-[10px] border border-line-soft bg-paper px-3 py-1.5 text-xs transition hover:border-accent/40"
            >
              <Paperclip className="h-3 w-3 shrink-0 text-ink-soft" />
              <span className="max-w-52 truncate font-semibold text-accent-deep">{a.filename}</span>
              <span className="font-mono text-[10px] text-ink-soft">{fmtSize(a.size)}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ConversationView({ d }: { d: Conversation }): ReactElement {
  const qc = useQueryClient();
  const latestInbound = [...d.messages].reverse().find(m => m.kind === 'inbound');
  const root = d.messages[0];

  /* Latest message and anything unread open expanded; the rest collapse to
   * one line. read_at in the response reflects the state BEFORE this fetch
   * marked things read, so fresh mail arrives expanded. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    d.messages.forEach((m, i) => {
      if (i === d.messages.length - 1 || (m.kind === 'inbound' && !m.read_at)) map[m.id] = true;
    });
    return map;
  });
  const toggle = (id: string): void => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const [replyText, setReplyText] = useState('');
  const [files, setFiles] = useState<
    { filename: string; content: string; content_type: string; size: number }[]
  >([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | null): void => {
    if (!list) return;
    setFileError(null);
    let running = files.reduce((sum, f) => sum + f.size, 0);
    void Promise.all(
      [...list].map(
        f =>
          new Promise<{ filename: string; content: string; content_type: string; size: number } | null>(
            resolve => {
              running += f.size;
              if (running > 4 * 1024 * 1024) {
                setFileError('Attachments are limited to 4 MiB total');
                resolve(null);
                return;
              }
              const reader = new FileReader();
              reader.onload = () =>
                resolve({
                  filename: f.name,
                  content: String(reader.result).split(',')[1] ?? '',
                  content_type: f.type || 'application/octet-stream',
                  size: f.size,
                });
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(f);
            }
          )
      )
    ).then(read =>
      setFiles(prev => [...prev, ...read.filter((f): f is NonNullable<typeof f> => f !== null)])
    );
    if (fileInput.current) fileInput.current.value = '';
  };

  const attPayload = files.length
    ? { attachments: files.map(({ size: _s, ...rest }) => rest) }
    : {};
  const reply = useMutation({
    mutationFn: () =>
      latestInbound
        ? api.post(`/api/inbox/messages/${latestInbound.id}/reply`, {
            text: replyText,
            ...attPayload,
          })
        : api.post('/api/inbox/compose', {
            address_id: d.address_id,
            to: root?.kind === 'outbound' && root.to.length ? root.to : [d.counterpart],
            subject: /^re:/i.test(d.subject) ? d.subject : `Re: ${d.subject}`,
            text: replyText,
            ...attPayload,
          }),
    onSuccess: () => {
      setReplyText('');
      setFiles([]);
      void qc.invalidateQueries({ queryKey: ['inbox-conversation', d.seed] });
      void qc.invalidateQueries({ queryKey: ['inbox-messages'] });
    },
  });
  const suppress = useMutation({
    mutationFn: () => api.post('/api/suppressions', { address: d.counterpart, reason: 'manual' }),
  });

  const canReply = Boolean(latestInbound || (d.address_id && d.counterpart));

  return (
    <article className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate font-mono text-[11px] text-ink-soft">
          {d.our_address ? `via ${d.our_address}` : 'conversation'} · {d.messages.length}{' '}
          message{d.messages.length === 1 ? '' : 's'}
        </p>
        {latestInbound && d.counterpart && (
          <Button
            variant="ghost"
            onClick={() => suppress.mutate()}
            disabled={suppress.isPending || suppress.isSuccess}
          >
            {suppress.isSuccess ? 'Suppressed ✓' : 'Suppress sender'}
          </Button>
        )}
      </div>
      <ErrorNote error={suppress.error} />

      <h1 className="mt-2 text-[21px] font-semibold leading-snug text-ink">{d.subject}</h1>

      <div className="mt-4 space-y-2">
        {d.messages.map(m => {
          const ourSide = m.kind === 'outbound';
          if (!expanded[m.id]) {
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => toggle(m.id)}
                className="flex w-full items-baseline gap-2.5 rounded-[14px] border border-line-soft bg-paper px-4 py-2.5 text-left transition hover:border-line"
              >
                <span
                  className={`shrink-0 text-[13px] ${ourSide ? 'font-medium text-ink-soft' : 'font-semibold text-ink'}`}
                >
                  {ourSide ? `you · ${m.from.split('@')[0]}@` : m.from_name || m.from}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-soft">
                  {snippetOf(m)}
                </span>
                {ourSide && m.status && (
                  <span
                    className={`shrink-0 rounded-full px-2 py-px font-mono text-[9.5px] font-bold ${statusTone(m.status)}`}
                  >
                    {m.status}
                  </span>
                )}
                {m.attachments.length > 0 && (
                  <Paperclip className="h-3 w-3 shrink-0 text-ink-soft" />
                )}
                <span className="shrink-0 font-mono text-[10.5px] text-ink-soft">
                  {fmtTime(m.created_at)}
                </span>
              </button>
            );
          }
          return (
            <div key={m.id} onClick={() => d.messages.length > 1 && toggle(m.id)} className={d.messages.length > 1 ? 'cursor-pointer' : ''}>
              <div onClick={e => e.stopPropagation()} className="cursor-auto">
                <Message m={m} ourSide={ourSide} />
              </div>
            </div>
          );
        })}
      </div>

      {canReply && (
        <div className="mt-5 rounded-2xl border border-line bg-paper/60 px-4 py-3">
          <p className="font-mono text-[10.5px] text-ink-soft">
            replying as <b className="text-ink">{d.our_address}</b> · lands in the email log like
            any send
          </p>
          <textarea
            className="mt-2 min-h-[88px] w-full resize-y rounded-[10px] border border-line bg-card px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none transition placeholder:text-ink-soft/45 focus:border-accent focus:ring-2 focus:ring-accent/15"
            placeholder={`Reply to ${latestInbound ? (latestInbound.from_name ?? latestInbound.from) : (d.counterpart ?? '')}…`}
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
          />
          {files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span
                  key={`${f.filename}-${i}`}
                  className="flex max-w-full items-center gap-1.5 rounded-lg border border-line-soft bg-card px-2.5 py-1 text-[11.5px]"
                >
                  <Paperclip className="h-3 w-3 shrink-0 text-ink-soft" />
                  <span className="max-w-44 truncate font-semibold text-ink">{f.filename}</span>
                  <span className="font-mono text-[10px] text-ink-soft">{fmtSize(f.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.filename}`}
                    onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                    className="rounded-full p-0.5 text-ink-soft transition hover:bg-paper-deep hover:text-ink"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {fileError && <p className="mt-1.5 text-[11px] font-semibold text-bad">{fileError}</p>}
          <ErrorNote error={reply.error} />
          <div className="mt-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={e => addFiles(e.target.files)}
              />
              <button
                type="button"
                aria-label="Attach files"
                title="Attach files"
                onClick={() => fileInput.current?.click()}
                className="rounded-lg p-1.5 text-ink-soft transition hover:bg-card hover:text-ink"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <span className="text-[10.5px] text-ink-soft">
                delivered by the send pipeline · plain text
              </span>
            </span>
            <Button onClick={() => reply.mutate()} disabled={reply.isPending || !replyText.trim()}>
              {reply.isPending ? 'Sending…' : 'Send reply'}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

/* ── first-run setup ─────────────────────────────────────────────── */

function SetupCard(): ReactElement {
  const navigate = useNavigate({ from: '/inbox' });
  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ id: string; name: string; status: string }[]>('/api/domains'),
  });
  const active = domains.data?.filter(d => d.status === 'active') ?? [];
  const [domainId, setDomainId] = useState('');
  const chosen = domainId || active[0]?.id || '';

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

      {chosen && (
        <div className="mt-6 rounded-2xl border border-line-soft bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12.5px] font-semibold text-ink">
              Receiving status
              {active.length === 1 && (
                <span className="ml-1.5 font-mono text-[11px] font-normal text-ink-soft">
                  {active[0].name}
                </span>
              )}
            </p>
            {active.length > 1 && (
              <Dropdown
                value={chosen}
                onChange={setDomainId}
                options={active.map(d => ({ value: d.id, label: d.name }))}
              />
            )}
          </div>
          <div className="mt-1.5">
            <ReceivingChecks domainId={chosen} active />
          </div>
        </div>
      )}

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
