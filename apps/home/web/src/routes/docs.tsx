import type { ReactElement, ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SiteChrome } from '../site/chrome';

export const Route = createFileRoute('/docs')({
  component: DocsPage,
});

/* One-page reference. Everything here describes shipped behavior - when the
 * platform changes, this page changes in the same batch. */

function H2({ id, children }: { id: string; children: ReactNode }): ReactElement {
  return (
    <h2 id={id} className="display mt-16 scroll-mt-24 font-display text-3xl text-ink first:mt-0">
      <a href={`#${id}`} className="hover:text-accent">
        {children}
      </a>
    </h2>
  );
}

function H3({ children }: { children: ReactNode }): ReactElement {
  return <h3 className="mt-8 font-display text-lg font-semibold text-ink">{children}</h3>;
}

function P({ children }: { children: ReactNode }): ReactElement {
  return <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{children}</p>;
}

function Code({ children }: { children: string }): ReactElement {
  return (
    <pre className="mt-4 overflow-x-auto rounded-xl bg-ink-deep p-4 font-mono text-[12.5px] leading-relaxed text-cream/90">
      <code>{children}</code>
    </pre>
  );
}

function Mono({ children }: { children: ReactNode }): ReactElement {
  return (
    <code className="rounded bg-paper-deep px-1.5 py-0.5 font-mono text-[13px] text-ink">
      {children}
    </code>
  );
}

function FieldTable({ rows }: { rows: [string, string][] }): ReactElement {
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-line-soft bg-white">
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-line-soft">
          {rows.map(([field, desc]) => (
            <tr key={field}>
              <td className="whitespace-nowrap px-4 py-2.5 align-top font-mono text-[12.5px] font-semibold text-ink">
                {field}
              </td>
              <td className="px-4 py-2.5 text-[13.5px] leading-relaxed text-ink-soft">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NAV: { id: string; label: string }[] = [
  { id: 'quickstart', label: 'Quickstart' },
  { id: 'auth', label: 'Authentication' },
  { id: 'api', label: 'Send API' },
  { id: 'replies', label: 'Replies API' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'inbox', label: 'Inbox setup' },
  { id: 'mcp', label: 'MCP for agents' },
  { id: 'updates', label: 'Updates' },
];

function DocsPage(): ReactElement {
  return (
    <SiteChrome>
      <main className="mx-auto flex max-w-6xl gap-12 px-5 py-16">
        {/* sticky section nav */}
        <nav className="sticky top-24 hidden h-max w-44 shrink-0 lg:block">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-soft">
            On this page
          </p>
          <ul className="mt-3 space-y-1.5 text-sm">
            {NAV.map(n => (
              <li key={n.id}>
                <a href={`#${n.id}`} className="text-ink-soft transition hover:text-ink">
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 max-w-3xl">
          <p className="text-[15px] font-medium text-accent">Docs</p>
          <h1 className="display mt-2 font-display text-4xl text-ink sm:text-5xl">
            The whole platform on one page
          </h1>
          <P>
            Postey runs in your Cloudflare account, so every URL below is on{' '}
            <strong>your</strong> domain. This page documents shipped behavior - the API is
            deliberately small enough to read in one sitting.
          </P>

          <H2 id="quickstart">Quickstart</H2>
          <P>
            <a className="font-semibold text-accent-deep underline" href="/deploy">
              Deploy Postey
            </a>{' '}
            (a Workers Paid plan and a domain on Cloudflare DNS are the prerequisites), create an
            API key in the dashboard, and send:
          </P>
          <Code>{`curl https://<your-send-worker>/api/emails \\
  -H "Authorization: Bearer pk_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "Acme <hello@yourdomain.com>",
    "to": ["customer@example.com"],
    "subject": "Your receipt",
    "html": "<h1>Thanks!</h1>"
  }'

→ 200 { "data": { "id": "msg_8fk2…" } }`}</Code>
          <P>
            Resend SDKs work as-is: point the client's base URL at your instance and swap the key.
            The SDK's <Mono>POST /emails</Mono> path is served alongside{' '}
            <Mono>POST /api/emails</Mono>.
          </P>

          <H2 id="auth">Authentication</H2>
          <P>
            Every API request carries <Mono>Authorization: Bearer pk_live_…</Mono>. Keys are
            created in the dashboard, hashed at rest, and optionally scoped to one domain - a
            scoped key can only send from, and read mail belonging to, that domain. Revocation is
            immediate.
          </P>

          <H2 id="api">Send API</H2>
          <H3>POST /api/emails</H3>
          <FieldTable
            rows={[
              ['from', 'Sender - "Name <addr@yourdomain>" or a bare address on an active domain.'],
              ['to, cc, bcc', 'Recipient addresses (arrays; to also accepts a single string).'],
              ['subject', 'Subject line. Optional when template_id supplies one.'],
              ['html, text', 'Body parts - at least one required (or use a template).'],
              ['reply_to', 'Optional Reply-To address.'],
              ['headers', 'Optional custom headers (string map).'],
              ['tags', 'Optional [{ name, value }] pairs, echoed in webhooks.'],
              [
                'attachments',
                'Optional [{ filename, content (base64), content_type?, disposition?, content_id? }]. Inline images: disposition "inline" + reference as cid:<content_id> in the HTML.',
              ],
              ['template_id', 'Send a stored template by id or slug; variables fills its {{placeholders}}.'],
              [
                'idempotency_key',
                'Also accepted as an Idempotency-Key header (header wins). Retries with the same key return the same message; a previously failed message is re-attempted, not replayed.',
              ],
            ]}
          />
          <H3>Responses are Cloudflare's real answer</H3>
          <P>
            Delivery happens inline in the request - there is no queue pretending a send worked.{' '}
            <Mono>200</Mono> means Email Service accepted the message. <Mono>429</Mono> with{' '}
            <Mono>Retry-After</Mono> means the reputation-gated daily cap hit - back off and
            retry. <Mono>422</Mono> is a validation or suppression rejection; <Mono>502</Mono> is
            an upstream failure, safe to retry under the same idempotency key.
          </P>
          <H3>Reading sends</H3>
          <P>
            <Mono>GET /api/emails</Mono> lists recent sends; <Mono>GET /api/emails/:id</Mono>{' '}
            returns one message with per-recipient status, lifecycle timestamps, and errors.
            Delivery states upgrade asynchronously (sent → delivered / bounced / complained) as
            Cloudflare's events arrive.
          </P>

          <H2 id="replies">Replies API</H2>
          <P>Inbound mail stored by the Inbox is readable with the same API key:</P>
          <FieldTable
            rows={[
              ['GET /api/replies', 'Recent inbound mail, newest first. ?unread=true filters; ?limit up to 50.'],
              [
                'GET /api/replies/:id',
                'Full content: text + html, sender, subject, the outbound message id it replies to, and attachment metadata [{ index, filename, type, size, disposition }]. Reading marks it read.',
              ],
              [
                'GET /api/replies/:id/attachments/:idx',
                'Attachment content - raw bytes by default; ?format=base64 returns a JSON envelope (4 MiB inline limit).',
              ],
              [
                'POST /api/replies/:id/reply',
                '{ text } - replies as the address that received the mail, threaded via In-Reply-To, recorded in the send log like any send.',
              ],
              [
                'GET /api/conversations/:id',
                'The whole exchange around any message id (msg_… or inb_…) as one chronological list - sends, replies, answers, bodies and attachment metadata included. Reading it marks inbound mail read.',
              ],
            ]}
          />

          <H2 id="webhooks">Webhooks</H2>
          <P>
            Endpoints are configured in the dashboard, each with its own signing secret. Postey
            POSTs JSON events - <Mono>email.sent</Mono>, <Mono>email.delivered</Mono>,{' '}
            <Mono>email.bounced</Mono>, <Mono>email.complained</Mono>, <Mono>email.failed</Mono>,{' '}
            <Mono>email.suppressed</Mono>, <Mono>email.reply.received</Mono> (or <Mono>*</Mono>)
            - with up to three attempts and a delivery log. A <strong>Send test</strong> button in
            the dashboard fires a signed sample event so you can verify your handler before real
            traffic.
          </P>
          <P>
            <Mono>email.reply.received</Mono> is full-fidelity: alongside the ids it carries the
            parsed <Mono>text</Mono> (capped at 20k chars, with <Mono>text_truncated</Mono> set
            when cut) and the attachment manifest{' '}
            <Mono>[{'{ index, filename, type, size }'}]</Mono> - so most receivers can act on a
            reply without fetching anything back. HTML stays behind{' '}
            <Mono>GET /api/replies/:id</Mono>.
          </P>
          <H3>Verifying signatures</H3>
          <P>
            Every delivery carries <Mono>Postey-Event</Mono> (the event name) and{' '}
            <Mono>Postey-Signature</Mono>: <Mono>sha256=</Mono> + HMAC-SHA256 of the raw request
            body, hex-encoded, keyed with the endpoint's secret. Verify against the raw bytes
            before parsing:
          </P>
          <Code>{`import { createHmac, timingSafeEqual } from "node:crypto";

function verifyPostey(rawBody, signatureHeader) {
  const expected = "sha256=" +
    createHmac("sha256", process.env.POSTEY_WEBHOOK_SECRET)
      .update(rawBody, "utf8").digest("hex");
  const got = Buffer.from(signatureHeader ?? "");
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}`}</Code>

          <H2 id="inbox">Inbox setup</H2>
          <P>
            Receiving is a deliberate, two-click step in Cloudflare that Postey never performs
            for you - your mail routing stays yours:
          </P>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-[15px] leading-relaxed text-ink-soft">
            <li>
              Enable <strong>Email Routing</strong> on your sending domain's zone (Cloudflare
              adds the MX records).
            </li>
            <li>
              Set the <strong>catch-all</strong> rule to <strong>Send to a Worker</strong> → your{' '}
              <Mono>…-inbound</Mono> worker.
            </li>
            <li>
              Create addresses in the dashboard - <Mono>support@</Mono> becomes real instantly;
              unknown addresses keep bouncing, so the catch-all never becomes a spam trap.
            </li>
          </ol>
          <P>
            The dashboard verifies the path honestly: a DNS check confirms Email Routing is
            enabled, and a <strong>self-probe</strong> - the instance emails itself through the
            real MX → catch-all → worker pipeline - proves delivery reaches the inbound worker.
            Both checks live on the Inbox setup card and each domain's detail page.
          </P>
          <P>
            Stored mail is parsed with postal-mime, threaded to the send it answers via{' '}
            <Mono>References</Mono>, kept with its attachments in your R2, and announced with an{' '}
            <Mono>email.reply.received</Mono> webhook.
          </P>

          <H2 id="mcp">MCP for agents</H2>
          <P>
            The send worker hosts an MCP server (Streamable HTTP, same Bearer key as the REST
            API) so coding agents get the whole loop - send, read replies, fetch attachments,
            answer:
          </P>
          <Code>{`claude mcp add --transport http postey \\
  https://<your-send-worker>/api/mcp \\
  --header "Authorization: Bearer pk_live_…"`}</Code>
          <P>
            Twelve tools: <Mono>send_email</Mono>, <Mono>get_email</Mono>,{' '}
            <Mono>list_emails</Mono>, <Mono>list_templates</Mono>, <Mono>create_template</Mono>,{' '}
            <Mono>list_replies</Mono>, <Mono>get_reply</Mono>, <Mono>get_reply_attachment</Mono>,{' '}
            <Mono>get_conversation</Mono>, <Mono>reply_to</Mono>, <Mono>suppress_address</Mono>,{' '}
            <Mono>list_suppressions</Mono>.
            Every tool dispatches to the real REST routes, so key scoping, idempotency, and
            suppression checks apply exactly as they do to your own code.
          </P>

          <H2 id="updates">Updates</H2>
          <P>
            Releases are prebuilt, versioned bundles (worker code + D1 migrations). Your instance
            checks the registry and applies updates with one click from the dashboard - a failed
            update never takes down a live instance. Nothing in an update, or in normal
            operation, gives Postey the project access to your mail.
          </P>
        </article>
      </main>
    </SiteChrome>
  );
}
