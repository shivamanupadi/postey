import type { ReactElement, ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SiteChrome } from '../site/chrome';

export const Route = createFileRoute('/')({
  component: Landing,
});

/* The landing page is a story told in numbered chapters - one idea per band,
 * in reading order: send → honest delivery → receive → agents → the rest of
 * the product layer → install → pricing. Grids repeating the story were
 * deliberately removed; the architecture detail lives on /docs. */

/* ---------------------------------- data --------------------------------- */

const PRODUCT_LAYER: { title: string; body: string }[] = [
  {
    title: 'Email log & previews',
    body: 'Every send with per-recipient status and the rendered HTML.',
  },
  {
    title: 'Templates',
    body: 'Versioned, with declared variables and test sends.',
  },
  {
    title: 'Suppression list',
    body: 'Bounces and complaints auto-populate it; blocked sends are never billed.',
  },
  {
    title: 'Webhooks',
    body: 'Signed events with retries, a delivery log, and one-click test deliveries.',
  },
  {
    title: 'Scoped API keys',
    body: 'Per-domain or account-wide, hashed at rest, revoked in one click.',
  },
  {
    title: 'Verified receiving',
    body: 'A DNS check plus a self-probe prove mail actually reaches your worker.',
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: 'What do I need to install Postey?',
    a: 'A Cloudflare account on the Workers Paid plan ($5/mo) with your sending domain on Cloudflare DNS. The deploy wizard verifies the plan before provisioning anything.',
  },
  {
    q: 'Is anything manual during install?',
    a: 'One step: Cloudflare has no public API yet for onboarding a domain to Email Sending, so the wizard deep-links you to the dashboard for two clicks (Onboard Domain → Done). It detects completion automatically by watching your DNS, then verifies the deployment end to end.',
  },
  {
    q: 'How many emails can I send per day?',
    a: 'Cloudflare applies a reputation-based daily cap that starts conservative and grows with clean sending. If you hit it, the API tells you immediately - a 429 with a Retry-After - so your app can back off or fall back. You can also ask Cloudflare for a higher limit.',
  },
  {
    q: 'How does receiving (the Inbox) work?',
    a: "Enable Email Routing on your zone and point the catch-all at Postey's inbound worker - a deliberate two-click step in Cloudflare that Postey never performs for you, because your mail routing is yours. The dashboard then verifies the whole path honestly: a DNS check confirms routing is enabled, and a self-probe (the instance emails itself) proves the catch-all really delivers to the worker.",
  },
  {
    q: 'Does any of my data leave my account?',
    a: 'No. Workers, D1, R2, and Queues all live in your Cloudflare account. The only thing Postey the project hosts is the deploy wizard and the release registry that ships you updates.',
  },
  {
    q: 'How do updates work?',
    a: 'Same model as Traks: prebuilt, versioned releases. Your instance checks the registry and applies updates (worker bundles + D1 migrations) with one click - a failed update never takes down a live instance.',
  },
];

/* ------------------------------- components ------------------------------ */

function SectionTitle({
  kicker,
  chapter,
  title,
  body,
  light = false,
  align = 'center',
}: {
  kicker: string;
  chapter?: string;
  title: string;
  body?: string;
  light?: boolean;
  align?: 'center' | 'left';
}): ReactElement {
  return (
    <div className={align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      <p
        className={`font-mono text-[14px] font-semibold ${light ? 'text-[#ff8fa3]' : 'text-accent'}`}
      >
        {chapter ? (
          <span className={light ? 'text-cream/45' : 'text-ink-soft'}>{chapter} · </span>
        ) : null}
        {kicker}
      </p>
      <h2
        className={`display mt-3 text-balance font-display text-4xl sm:text-[44px] sm:leading-[1.08] ${light ? 'text-cream' : 'text-ink'}`}
      >
        {title}
      </h2>
      {body ? (
        <p
          className={`mt-5 text-[17px] leading-relaxed ${light ? 'text-cream/70' : 'text-ink-soft'}`}
        >
          {body}
        </p>
      ) : null}
    </div>
  );
}

function Chips({ items, light = false }: { items: string[]; light?: boolean }): ReactElement {
  return (
    <div className="mt-7 flex flex-wrap gap-2.5">
      {items.map(s => (
        <span
          key={s}
          className={`rounded-lg border px-2.5 py-1 font-mono text-xs ${
            light
              ? 'border-cream/20 bg-cream/5 text-cream/60'
              : 'border-line bg-white/60 text-ink-soft'
          }`}
        >
          {s}
        </span>
      ))}
    </div>
  );
}

function Terminal({
  caption,
  children,
  framed = false,
}: {
  caption: string;
  children: ReactNode;
  framed?: boolean;
}): ReactElement {
  return (
    <div
      className={`overflow-hidden rounded-2xl bg-ink-deep ${
        framed
          ? 'border border-cream/15'
          : 'shadow-[0_24px_48px_-20px_rgba(30,25,18,0.35)]'
      }`}
    >
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="ml-3 font-mono text-xs text-cream/50">{caption}</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-cream/90">
        <code>{children}</code>
      </pre>
    </div>
  );
}

/* --------------------------------- page ---------------------------------- */

function Landing(): ReactElement {
  return (
    <SiteChrome>
      <main>
      {/* Hero */}
      <section className="px-5 pb-24 pt-20 text-center sm:pt-28">
        <div className="mx-auto max-w-4xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white/55 px-3.5 py-1.5 text-[13px] font-medium text-ink-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            Public beta · built on Cloudflare Email Service
          </span>
          <h1 className="display mx-auto mt-8 max-w-[16ch] text-balance font-display text-5xl leading-[1.05] text-ink sm:text-6xl lg:text-[72px]">
            The email platform you actually own.
          </h1>
          <p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-ink-soft">
            Postey installs two products into your own Cloudflare account: a
            Resend-compatible transactional email API, and an Inbox that threads replies back
            to the sends they answer - readable by you in the dashboard and by your agents
            over MCP. No middleman, no per-email markup, no data leaving your infrastructure.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <a
              href="/deploy"
              className="group rounded-[10px] bg-ink px-7 py-3.5 text-[17px] font-medium text-white transition hover:bg-black"
            >
              Deploy to Cloudflare{' '}
              <span className="inline-block transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </a>
            <a
              href="#send"
              className="rounded-[10px] border border-line bg-white px-7 py-3.5 text-[17px] font-medium text-ink transition hover:bg-paper-deep/40"
            >
              Read the story
            </a>
          </div>
          <p className="mt-6 font-mono text-xs text-ink-soft">
            $5/mo Workers plan · 3,000 emails included · then $0.35 per 1,000
          </p>
        </div>
      </section>

      {/* 01 · Send */}
      <section id="send" className="scroll-mt-20 border-y border-line-soft bg-paper-deep">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 lg:grid-cols-[5fr_6fr]">
          <div>
            <SectionTitle
              align="left"
              chapter="01"
              kicker="Send"
              title="Transactional email, from your own domain."
              body="Receipts, magic links, alerts - sent by Workers you control, on infrastructure you own. The API is Resend-compatible, so migrating is changing the base URL and the key; your SDK stays."
            />
            <Chips items={['node', 'python', 'go', 'curl', 'rest']} />
          </div>
          <Terminal caption="already on Resend? just change two lines">
            {`curl `}
            <span className="text-[#ff8fa3]">https://mail.yourdomain.com</span>
            {`/api/emails \\
  -H "Authorization: Bearer `}
            <span className="text-[#ff8fa3]">pk_live_…</span>
            {`" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "Acme <hello@yourdomain.com>",
    "to": ["customer@example.com"],
    "subject": "Your receipt",
    "html": "<h1>Thanks!</h1>"
  }'

`}
            <span className="text-cream/50">{`→ 200 { "id": "msg_8fk2…" }  · delivered inline, no queue`}</span>
          </Terminal>
        </div>
      </section>

      {/* 02 · Honest delivery */}
      <section id="truth" className="scroll-mt-20 py-24">
        <div className="mx-auto max-w-6xl px-5">
          <SectionTitle
            chapter="02"
            kicker="Honest delivery"
            title="The response is the truth."
            body="Delivery happens inside the request - there is no queue pretending your mail went out. The API returns Cloudflare's real answer, and a retry under the same idempotency key re-attempts the same message, never a duplicate."
          />
          <div className="mx-auto mt-11 grid max-w-4xl gap-3.5 sm:grid-cols-3">
            {[
              {
                code: '200 sent',
                tone: 'text-[#1a7f4e]',
                body: 'Email Service accepted it. The id is real, the message is on its way.',
              },
              {
                code: '429 + Retry-After',
                tone: 'text-[#9a6700]',
                body: 'The reputation-gated daily cap hit. Back off and retry - same key, same message, sent once.',
              },
              {
                code: '422 suppressed',
                tone: 'text-[#b42318]',
                body: 'The recipient bounced hard or complained before. Blocked at the boundary, never billed.',
              },
            ].map(r => (
              <div
                key={r.code}
                className="rounded-2xl border border-line-soft bg-white p-5 shadow-[0_1px_2px_rgba(30,25,18,0.04)]"
              >
                <p className={`font-mono text-[15px] font-semibold ${r.tone}`}>{r.code}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{r.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 03 · Receive */}
      <section id="inbox" className="scroll-mt-20 border-y border-line-soft bg-paper-deep">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 lg:grid-cols-[6fr_5fr]">
          {/* thread mock */}
          <div className="rounded-2xl border border-line-soft bg-white p-5 text-[13px] shadow-[0_24px_48px_-24px_rgba(30,25,18,0.25)]">
            <div className="rounded-xl border border-line-soft px-3.5 py-3">
              <div className="flex items-center justify-between font-mono text-[10.5px] text-ink-soft">
                <span>
                  <b className="font-semibold text-ink">billing@yourdomain.com</b> →
                  jane@customer.io
                </span>
                <span className="rounded-full bg-[#e3f2e9] px-2 py-px font-bold text-[#1a7f4e]">
                  delivered
                </span>
              </div>
              <p className="mt-1.5 text-[13.5px] font-semibold text-ink">
                Invoice INV-2026-0142 for September
              </p>
            </div>
            <div className="ml-6 mt-2.5 rounded-xl border border-accent/30 px-3.5 py-3">
              <div className="flex items-center justify-between font-mono text-[10.5px] text-ink-soft">
                <span>
                  <b className="font-semibold text-ink">Jane Cooper</b> → support@yourdomain.com
                </span>
                <span className="rounded-full bg-accent-soft px-2 py-px font-bold text-accent-deep">
                  received
                </span>
              </div>
              <p className="mt-1.5 text-[13.5px] font-semibold text-ink">
                Re: Invoice INV-2026-0142 for September
              </p>
              <p className="mt-1.5 leading-relaxed text-ink-soft">
                Payment went out this morning - can you switch our billing address to the Berlin
                office?
              </p>
              <span className="mt-2.5 inline-flex items-center gap-2 rounded-[9px] border border-line-soft bg-paper px-2.5 py-1.5 text-xs font-semibold text-accent-deep">
                📎 invoice-signed.pdf{' '}
                <em className="font-mono text-[10.5px] font-normal not-italic text-ink-soft">
                  84 KB
                </em>
              </span>
            </div>
          </div>
          <div>
            <SectionTitle
              align="left"
              chapter="03"
              kicker="Receive"
              title="Replies come back. Threaded."
              body="Point your zone's catch-all at the inbound worker - a deliberate two-click step; Postey never touches your routing - and support@ becomes real. Replies render mail-client-clean, attachments and all, threaded to the send they answer. A self-probe verifies the whole path actually works."
            />
            <Chips items={['threading', 'attachments', 'reply webhook', 'verified setup']} />
          </div>
        </div>
      </section>

      {/* 04 · Agents - the one dark band */}
      <section id="agents" className="scroll-mt-20 bg-ink-deep">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 lg:grid-cols-[5fr_6fr]">
          <div>
            <SectionTitle
              light
              align="left"
              chapter="04"
              kicker="Agents"
              title="Your agents work the mailbox."
              body="The built-in MCP server hands coding agents the whole loop with one Bearer key: send, read the replies, fetch the attachments, answer as the address that received the mail. Eleven tools, dispatching through the same routes your code uses."
            />
            <Chips
              light
              items={['send_email', 'list_replies', 'get_reply_attachment', 'reply_to', '+7 more']}
            />
          </div>
          <Terminal framed caption="an agent closing the loop">
            {`› list_replies `}
            <span className="text-cream/50">{`{ unread: true }`}</span>
            {`
  ↳ Re: Your receipt · jane@customer.io · 1 attachment

› get_reply_attachment `}
            <span className="text-cream/50">{`{ id: "inb_8fk2…", index: 0 }`}</span>
            {`
  ↳ invoice-signed.pdf · application/pdf · 84 KB

› reply_to `}
            <span className="text-cream/50">{`{ id: "inb_8fk2…", text: "Got it - processing." }`}</span>
            {`
  ↳ sent as `}
            <span className="text-[#ff8fa3]">support@yourdomain.com</span>
            {` · threaded`}
          </Terminal>
        </div>
      </section>

      {/* 05 · Product layer */}
      <section id="layer" className="scroll-mt-20 py-24">
        <div className="mx-auto max-w-6xl px-5">
          <SectionTitle
            chapter="05"
            kicker="The product layer"
            title="Everything the raw API doesn't give you."
            body="Cloudflare Email Service delivers the mail, signs DKIM, and manages IP reputation. Postey adds the layer you'd otherwise build yourself."
          />
          <div className="mx-auto mt-10 grid max-w-4xl gap-x-14 sm:grid-cols-2">
            {PRODUCT_LAYER.map(f => (
              <div key={f.title} className="flex gap-3.5 border-b border-line-soft px-1 py-4">
                <span className="mt-0.5 flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent-deep">
                  ✓
                </span>
                <div>
                  <p className="text-[14.5px] font-semibold text-ink">{f.title}</p>
                  <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-soft">{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 06 · Install */}
      <section id="deploy" className="scroll-mt-20 border-y border-line-soft bg-paper-deep py-24">
        <div className="mx-auto max-w-6xl px-5">
          <SectionTitle chapter="06" kicker="Install" title="Yours in about five minutes." />
          <div className="mx-auto mt-12 max-w-xl">
            {[
              {
                n: '01',
                title: 'Connect Cloudflare',
                body: 'Authorize the wizard with a scoped API token. It verifies your Workers Paid plan and picks your zone.',
              },
              {
                n: '02',
                title: 'Provision & onboard',
                body: 'Workers, D1, and R2 deploy automatically. One deep-linked click onboards your domain - SPF, DKIM, and DMARC records are created and locked for you.',
              },
              {
                n: '03',
                title: 'Send',
                body: 'The wizard watches your DNS go live, verifies the deployment end to end, and hands you your dashboard.',
              },
            ].map((s, i, all) => (
              <div key={s.n} className="relative grid grid-cols-[46px_1fr] gap-5 pb-9 last:pb-0">
                {i < all.length - 1 && (
                  <span className="absolute bottom-1 left-[22px] top-12 w-0.5 bg-line" />
                )}
                <span className="flex h-[46px] w-[46px] items-center justify-center rounded-full border border-line bg-white font-mono text-sm font-semibold text-accent">
                  {s.n}
                </span>
                <div>
                  <h3 className="pt-2 font-display text-lg font-semibold tracking-tight text-ink">
                    {s.title}
                  </h3>
                  <p className="mt-1.5 max-w-[52ch] text-[14.5px] leading-relaxed text-ink-soft">
                    {s.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 07 · Pricing */}
      <section id="pricing" className="scroll-mt-20 py-24">
        <div className="mx-auto max-w-4xl px-5">
          <SectionTitle
            chapter="07"
            kicker="Pricing"
            title="You pay Cloudflare. That's it."
            body="Postey is software you run, not a service you subscribe to. There is exactly one bill, and it isn't ours."
          />
          <div className="mt-11 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-line-soft bg-white p-7 shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
                Cloudflare's bill · the only one
              </p>
              <p className="mt-2.5 font-mono text-4xl font-semibold tracking-tight text-ink">
                $5<span className="text-[15px] font-normal text-ink-soft">/mo</span>
              </p>
              <ul className="mt-4 space-y-2 text-[13.5px] leading-relaxed text-ink-soft">
                <li>Workers Paid plan - runs the whole platform</li>
                <li>3,000 emails a month included</li>
                <li>then $0.35 per 1,000 emails</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-accent/35 bg-accent-soft p-7">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-soft">
                Postey's bill
              </p>
              <p className="mt-2.5 font-mono text-4xl font-semibold tracking-tight text-accent-deep">
                $0
              </p>
              <ul className="mt-4 space-y-2 text-[13.5px] leading-relaxed text-ink-soft">
                <li>No markup per email</li>
                <li>No seats, no tiers, no license fee</li>
                <li>MIT-licensed software in your account - updates included</li>
              </ul>
            </div>
          </div>
          <p className="mt-4 text-center text-xs text-ink-soft">
            For scale: 100,000 emails/mo lands around $39 in Cloudflare usage - Resend charges
            $40, Postmark ~$100 (published pricing, August 2026).
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-line-soft bg-paper-deep py-24">
        <div className="mx-auto max-w-3xl px-5">
          <SectionTitle kicker="FAQ" title="The honest fine print" />
          <div className="mt-10 space-y-3">
            {FAQ.map(item => (
              <details
                key={item.q}
                className="group rounded-xl border border-line-soft bg-white px-5 py-4 open:shadow-sm"
              >
                <summary className="cursor-pointer list-none text-sm font-semibold text-ink marker:hidden">
                  {item.q}
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-line-soft py-24">
        <div className="mx-auto max-w-3xl px-5 text-center">
          <img src="/logo.svg" alt="" className="mx-auto h-14 w-14" />
          <h2 className="display mt-6 text-balance font-display text-4xl text-ink sm:text-[44px]">
            Own your email. All of it.
          </h2>
          <p className="mt-4 text-base text-ink-soft">
            Deploy Postey into your Cloudflare account and send your first email in minutes.
          </p>
          <a
            href="/deploy"
            className="group mt-9 inline-block rounded-[10px] bg-ink px-8 py-3.5 text-[17px] font-medium text-white transition hover:bg-black"
          >
            Deploy to Cloudflare{' '}
            <span className="inline-block transition-transform group-hover:translate-x-0.5">→</span>
          </a>
        </div>
      </section>
      </main>
    </SiteChrome>
  );
}
