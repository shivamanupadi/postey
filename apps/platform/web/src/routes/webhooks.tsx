import { lazy, Suspense, useState, type ReactElement, type FormEvent, type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api, fmtTime } from '@/lib/api';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  Empty,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Segmented,
  Table,
} from '@/lib/ui';

const CodeEditor = lazy(() => import('@/lib/code-editor'));

/* ── signature-verification snippets ─────────────────────────────── */

type VerifyLang = 'node' | 'python';

const VERIFY_SNIPPETS: Record<VerifyLang, string> = {
  node: `import { createHmac, timingSafeEqual } from "node:crypto";

// Set POSTEY_WEBHOOK_SECRET to this endpoint's signing secret (above).
// Verify against the RAW body - parse JSON only after this passes.
function verifyPostey(rawBody, signatureHeader) {
  const expected =
    "sha256=" +
    createHmac("sha256", process.env.POSTEY_WEBHOOK_SECRET)
      .update(rawBody, "utf8")
      .digest("hex");
  const got = Buffer.from(signatureHeader ?? "");
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Express example:
// app.post("/webhooks/postey", express.raw({ type: "*/*" }), (req, res) => {
//   if (!verifyPostey(req.body, req.get("Postey-Signature")))
//     return res.sendStatus(401);
//   const event = JSON.parse(req.body);
//   // event.type: "email.delivered" | "email.bounced" | ...
//   // event.data: { message_id, subject, from, recipient?, tags? }
//   res.sendStatus(200);
// });`,
  python: `import hmac, hashlib, os

# Set POSTEY_WEBHOOK_SECRET to this endpoint's signing secret (above).
# Verify against the RAW body bytes - parse JSON only after this passes.
def verify_postey(raw_body: bytes, signature_header: str | None) -> bool:
    expected = "sha256=" + hmac.new(
        os.environ["POSTEY_WEBHOOK_SECRET"].encode(),
        raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature_header or "", expected)

# Flask example:
# @app.post("/webhooks/postey")
# def postey_webhook():
#     if not verify_postey(request.get_data(), request.headers.get("Postey-Signature")):
#         return "", 401
#     event = request.get_json()  # {"type": "email.bounced", "data": {...}}
#     return "", 200`,
};

function VerifySnippet(): ReactElement {
  const [lang, setLang] = useState<VerifyLang>('node');
  const [copied, setCopied] = useState(false);
  const snippet = VERIFY_SNIPPETS[lang];
  return (
    <div>
      <div className="flex items-center justify-between">
        <Segmented options={['node', 'python'] as const} value={lang} onChange={setLang} />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(snippet).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            copied
              ? 'bg-accent-soft text-accent-deep'
              : 'border border-line text-ink-soft hover:bg-card hover:text-ink'
          }`}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <div className="mt-2 overflow-hidden rounded-xl border border-line">
        <Suspense
          fallback={
            <div className="flex h-[180px] items-center justify-center bg-card text-xs text-ink-soft">
              Loading…
            </div>
          }
        >
          <CodeEditor
            value={snippet}
            lang={lang === 'node' ? 'javascript' : 'python'}
            readOnly
            height="auto"
          />
        </Suspense>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/webhooks')({
  component: WebhooksPage,
});

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events_json: string;
  enabled: number;
  created_at: number;
}

interface DeliveryRow {
  id: string;
  event_type: string | null;
  status: string;
  attempts: number;
  response_code: number | null;
  last_attempt_at: number | null;
}

const ALL_EVENTS = [
  'email.sent',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.failed',
  'email.suppressed',
  'email.reply.received',
];

const eventsOf = (h: WebhookRow): string[] => {
  try {
    return JSON.parse(h.events_json) as string[];
  } catch {
    return [];
  }
};

const useDeliveries = (hookId: string) =>
  useQuery({
    queryKey: ['wh-deliveries', hookId],
    queryFn: () => api.get<DeliveryRow[]>(`/api/webhooks/${hookId}/deliveries`),
    staleTime: 15_000,
  });

/** Last few deliveries as colored ticks, oldest left. */
function DeliveryTicks({ hookId }: { hookId: string }): ReactElement {
  const deliveries = useDeliveries(hookId);
  const recent = (deliveries.data ?? []).slice(0, 8).reverse();
  if (!recent.length)
    return <span className="text-[11px] text-ink-soft">no deliveries yet</span>;
  return (
    <span className="inline-flex items-center gap-[3px]">
      {recent.map(d => (
        <span
          key={d.id}
          title={`${d.event_type ?? 'event'} · ${d.response_code ?? 'no response'}`}
          className={`h-4 w-[7px] rounded-[3px] ${d.status === 'delivered' ? 'bg-ok/75' : 'bg-bad/85'}`}
        />
      ))}
    </span>
  );
}

function DisabledBadge(): ReactElement {
  return (
    <span className="inline-block rounded-full bg-paper-deep px-2.5 py-0.5 text-[11.5px] font-semibold text-ink-soft">
      disabled
    </span>
  );
}

function SecretRow({ secret }: { secret: string }): ReactElement {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const btn =
    'rounded-[7px] border border-line bg-card px-2.5 py-1 text-[11px] font-bold text-ink-soft transition hover:text-ink';
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-line-soft bg-paper px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-soft">
        {revealed ? secret : `${secret.slice(0, 6)}${'•'.repeat(16)}`}
      </code>
      <button type="button" onClick={() => setRevealed(v => !v)} className={btn}>
        {revealed ? 'Hide' : 'Reveal'}
      </button>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(secret).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className={`${btn} ${copied ? 'border-accent/40 text-accent-deep' : ''}`}
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

function DrawerSection({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section>
      <h3 className="mb-2 text-[12.5px] font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function WebhookDrawer({
  h,
  onClose,
  onEdit,
  onToggle,
  onDelete,
  toggling,
}: {
  h: WebhookRow;
  onClose: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  toggling: boolean;
}): ReactElement {
  const deliveries = useDeliveries(h.id);
  return (
    <Drawer
      title={<span className="break-all font-mono text-[14px]">{h.url}</span>}
      sub={
        <span className="flex items-center gap-2.5">
          {h.enabled ? <Badge status="active" /> : <DisabledBadge />}
          <span className="text-[11px] text-ink-soft">added {fmtTime(h.created_at)}</span>
        </span>
      }
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="ghost" onClick={onToggle} disabled={toggling}>
            {h.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button variant="danger" onClick={onDelete}>
            Delete
          </Button>
        </div>
        <DrawerSection title="Signing secret">
          <SecretRow secret={h.secret} />
          <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">
            Every delivery carries a <code className="font-mono text-[10.5px]">Postey-Signature</code>{' '}
            header: HMAC-SHA256 of the raw body with this secret, hex, prefixed{' '}
            <code className="font-mono text-[10.5px]">sha256=</code> (plus a{' '}
            <code className="font-mono text-[10.5px]">Postey-Event</code> header naming the event).
          </p>
        </DrawerSection>
        <DrawerSection title="Verify incoming requests">
          <VerifySnippet />
        </DrawerSection>
        <DrawerSection title="Subscribed events">
          <div className="flex flex-wrap gap-1">
            {eventsOf(h).map(ev => (
              <span
                key={ev}
                className="rounded-full border border-line-soft bg-paper px-2.5 py-0.5 font-mono text-[10px] text-ink-soft"
              >
                {ev}
              </span>
            ))}
          </div>
        </DrawerSection>
        <DrawerSection title="Recent deliveries">
          {deliveries.data?.length ? (
            <div className="divide-y divide-[#efe9df]">
              {deliveries.data.slice(0, 20).map(d => (
                <div key={d.id} className="flex items-center gap-2.5 py-2 text-xs">
                  <span
                    className={`h-[7px] w-[7px] shrink-0 rounded-full ${d.status === 'delivered' ? 'bg-ok' : 'bg-bad'}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                    {d.event_type ?? 'event'}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-ink-soft">
                    {d.response_code ?? 'no response'}
                    {d.attempts > 1 ? ` · ${d.attempts} attempts` : ''}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-ink-soft/80">
                    {d.last_attempt_at ? fmtTime(d.last_attempt_at) : '-'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-soft">
              {deliveries.isLoading ? 'Loading…' : 'No deliveries yet.'}
            </p>
          )}
        </DrawerSection>
      </div>
    </Drawer>
  );
}

function WebhooksPage(): ReactElement {
  const qc = useQueryClient();
  const hooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.get<WebhookRow[]>('/api/webhooks'),
  });

  /** null = closed; 'new' = create; WebhookRow = edit. */
  const [editing, setEditing] = useState<WebhookRow | 'new' | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([...ALL_EVENTS]);
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WebhookRow | null>(null);

  const inspecting = hooks.data?.find(h => h.id === inspectingId) ?? null;

  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['webhooks'] });
  const save = useMutation({
    mutationFn: () =>
      editing === 'new'
        ? api.post<{ id: string; secret: string }>('/api/webhooks', { url, events })
        : api.put(`/api/webhooks/${(editing as WebhookRow).id}`, { url, events }),
    onSuccess: data => {
      // After creating, open the drawer so the signing secret is right there.
      if (editing === 'new') setInspectingId((data as { id: string }).id);
      setEditing(null);
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (h: WebhookRow) => api.put(`/api/webhooks/${h.id}`, { enabled: !h.enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/webhooks/${id}`),
    onSuccess: () => {
      setDeleting(null);
      setInspectingId(null);
      refresh();
    },
  });

  const openNew = (): void => {
    setUrl('');
    setEvents([...ALL_EVENTS]);
    save.reset();
    setEditing('new');
  };
  const openEdit = (h: WebhookRow): void => {
    setUrl(h.url);
    setEvents(eventsOf(h));
    save.reset();
    setEditing(h);
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (url && events.length) save.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Webhooks"
        sub="Signed delivery events - delivered, bounced, complained, failed - pushed to your endpoints."
        action={<Button onClick={openNew}>Add endpoint</Button>}
      />
      <ErrorNote error={toggle.error} />

      {hooks.data?.length ? (
        <Table head={['Endpoint', 'Events', 'Last deliveries', 'Status', '']}>
          {hooks.data.map(h => (
            <tr
              key={h.id}
              onClick={() => setInspectingId(h.id)}
              className="cursor-pointer transition hover:bg-paper/60"
            >
              <td className="max-w-72 truncate px-4 py-3 font-mono text-xs font-semibold">
                {h.url}
              </td>
              <td className="px-4 py-3 text-xs text-ink-soft">{eventsOf(h).length} events</td>
              <td className="px-4 py-3">
                <DeliveryTicks hookId={h.id} />
              </td>
              <td className="px-4 py-3">{h.enabled ? <Badge status="active" /> : <DisabledBadge />}</td>
              <td className="px-4 py-3 text-right text-ink-soft">›</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{hooks.isLoading ? 'Loading…' : 'No webhooks configured.'}</Empty>
      )}

      {inspecting && !deleting && (
        <WebhookDrawer
          h={inspecting}
          onClose={() => setInspectingId(null)}
          onEdit={() => openEdit(inspecting)}
          onToggle={() => toggle.mutate(inspecting)}
          onDelete={() => {
            remove.reset();
            setDeleting(inspecting);
          }}
          toggling={toggle.isPending}
        />
      )}

      {editing && (
        <Modal
          title={editing === 'new' ? 'Add a webhook endpoint' : 'Edit endpoint'}
          sub="Postey signs and POSTs the selected events to it."
          onClose={() => setEditing(null)}
        >
          <form onSubmit={submit} className="mt-4 space-y-4">
            <Field label="Endpoint URL">
              <Input
                autoFocus
                type="url"
                required
                className="font-mono text-[13px]"
                placeholder="https://api.yourapp.com/postey"
                value={url}
                onChange={e => setUrl(e.target.value)}
              />
            </Field>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
                  Events
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setEvents(events.length === ALL_EVENTS.length ? [] : [...ALL_EVENTS])
                  }
                  className="text-[11px] font-bold text-ink-soft underline decoration-line underline-offset-2 hover:text-ink"
                >
                  {events.length === ALL_EVENTS.length ? 'Clear all' : 'Select all'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {ALL_EVENTS.map(ev => {
                  const on = events.includes(ev);
                  return (
                    <button
                      key={ev}
                      type="button"
                      onClick={() =>
                        setEvents(list => (on ? list.filter(x => x !== ev) : [...list, ev]))
                      }
                      className={`flex items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left font-mono text-xs transition ${
                        on
                          ? 'border-accent bg-accent-soft font-semibold text-accent-deep'
                          : 'border-line bg-card text-ink-soft hover:text-ink'
                      }`}
                    >
                      <span
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                          on ? 'border-accent bg-accent text-white' : 'border-line'
                        }`}
                      >
                        {on && <Check className="h-2.5 w-2.5" />}
                      </span>
                      {ev}
                    </button>
                  );
                })}
              </div>
            </div>
            {editing === 'new' && (
              <p className="text-xs leading-relaxed text-ink-soft">
                A signing secret is generated on create and shown in the endpoint's details -
                verify the <code className="font-mono text-[11px]">Postey-Signature</code> header
                with it.
              </p>
            )}
            <ErrorNote error={save.error} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" type="button" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending || !url || !events.length}>
                {editing === 'new' ? 'Add endpoint' : 'Save changes'}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this endpoint?"
          sub="This cannot be undone."
          confirmLabel="Delete endpoint"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-[10px] border border-line-soft bg-paper px-3.5 py-3 text-xs">
            <dt className="text-ink-soft">Endpoint</dt>
            <dd className="m-0 break-all font-mono text-[11.5px]">{deleting.url}</dd>
            <dt className="text-ink-soft">Events</dt>
            <dd className="m-0">{eventsOf(deleting).length} subscribed</dd>
            <dt className="text-ink-soft">Added</dt>
            <dd className="m-0">{fmtTime(deleting.created_at)}</dd>
          </dl>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">
            Event delivery to this URL stops immediately and its delivery log is removed.
            {deleting.enabled ? (
              <>
                {' '}
                If you just want to pause it,{' '}
                <button
                  type="button"
                  onClick={() => {
                    toggle.mutate(deleting);
                    setDeleting(null);
                  }}
                  className="font-semibold text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                >
                  disable it instead
                </button>{' '}
                - the secret and history stay.
              </>
            ) : null}
          </p>
          <ErrorNote error={remove.error} />
        </ConfirmDialog>
      )}
    </div>
  );
}
