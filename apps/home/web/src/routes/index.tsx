import type { ReactElement, ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SiteChrome } from '../site/chrome';
import {
  Inbox,
  KeyRound,
  LayoutTemplate,
  Plug,
  RefreshCw,
  ScrollText,
  ShieldOff,
  Webhook,
  Zap,
} from 'lucide-react';

export const Route = createFileRoute('/')({
  component: Landing,
});

/* ---------------------------------- data --------------------------------- */

const V1_FEATURES: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <Plug />,
    title: 'Resend-compatible API',
    body: 'Drop-in migration: change the base URL and the API key. Same payload shape for send, batch, attachments, and tags.',
  },
  {
    icon: <ScrollText />,
    title: 'Email log & previews',
    body: 'Every send recorded with per-recipient status, full headers, and the rendered HTML - searchable from the dashboard.',
  },
  {
    icon: <LayoutTemplate />,
    title: 'Templates',
    body: 'Versioned templates with declared variables, validated at send time. Send by template slug instead of shipping HTML in every request.',
  },
  {
    icon: <ShieldOff />,
    title: 'Suppression list',
    body: 'Hard bounces and complaints auto-populate the list; suppressed sends are blocked at the API boundary and never billed.',
  },
  {
    icon: <Webhook />,
    title: 'Webhooks',
    body: 'Signed delivered / bounced / complained / failed / reply events to your endpoints, with retries, a delivery log, and one-click test deliveries to verify your handler.',
  },
  {
    icon: <Zap />,
    title: 'Instant, honest responses',
    body: "Delivery happens in the request: the API returns Cloudflare's real answer - sent, or a clear 429/4xx with a Retry-After. No silent queue holding your mail.",
  },
  {
    icon: <RefreshCw />,
    title: 'Idempotent sends & retries',
    body: 'Idempotency keys guarantee an email is sent exactly once - and a retry after a rate limit re-attempts the same message instead of replaying the failure.',
  },
  {
    icon: <KeyRound />,
    title: 'Scoped API keys',
    body: 'Per-domain or account-wide keys, hashed at rest, with prefixes for display, last-used tracking, and one-click revocation.',
  },
  {
    icon: <Inbox />,
    title: 'Inbox: two-way email',
    body: 'Replies land in your dashboard threaded to the send they answer - rendered like a real mail client, attachments included. A reply webhook and MCP tools let agents read the answers, fetch the files, and reply back.',
  },
];

const PRICING_ROWS: { volume: string; postey: string; resend: string; postmark: string }[] = [
  { volume: '10,000 / mo', postey: '~$7', resend: '$20', postmark: '$16.50' },
  { volume: '50,000 / mo', postey: '~$21', resend: '$20', postmark: '~$60' },
  { volume: '100,000 / mo', postey: '~$39', resend: '$40', postmark: '~$100' },
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
  title,
  body,
  light = false,
  align = 'center',
}: {
  kicker: string;
  title: string;
  body?: string;
  light?: boolean;
  align?: 'center' | 'left';
}): ReactElement {
  return (
    <div className={align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      <p className={`text-[15px] font-medium ${light ? 'text-[#ff8fa3]' : 'text-accent'}`}>
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

function CodeBlock(): ReactElement {
  return (
    <div className="overflow-hidden rounded-2xl bg-ink-deep shadow-[0_24px_48px_-20px_rgba(30,25,18,0.35)]">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        <span className="ml-3 font-mono text-xs text-cream/50">
          already on Resend? just change two lines
        </span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-cream/90">
        <code>
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
        </code>
      </pre>
    </div>
  );
}

/* --------------------------------- page ---------------------------------- */

function Landing(): ReactElement {
  return (
    <SiteChrome>
      <main>
      {/* Hero - centered, openseo-style */}
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
            Postey installs a complete transactional email platform - API, logs, templates,
            suppressions, webhooks - into your own Cloudflare account. No middleman, no
            per-email markup, no data leaving your infrastructure.
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
              href="#features"
              className="rounded-[10px] border border-line bg-white px-7 py-3.5 text-[17px] font-medium text-ink transition hover:bg-paper-deep/40"
            >
              Explore the features
            </a>
          </div>
          <p className="mt-6 font-mono text-xs text-ink-soft">
            $5/mo Workers plan · 3,000 emails included · then $0.35 per 1,000
          </p>
        </div>
      </section>

      {/* API split band */}
      <section className="border-y border-line-soft bg-paper-deep">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 lg:grid-cols-[5fr_6fr]">
          <div>
            <SectionTitle
              align="left"
              kicker="Resend-compatible API"
              title="Keep your SDK. Change one URL."
              body="Postey speaks the same REST dialect your code already does. Point your existing client at your own domain and every send flows through Workers you control. The built-in MCP server gives coding agents the whole loop: send, read the replies - attachments included - and answer them."
            />
            <div className="mt-7 flex flex-wrap gap-2.5">
              {['node', 'python', 'go', 'curl', 'rest', 'mcp'].map(s => (
                <span
                  key={s}
                  className="rounded-lg border border-line bg-white/60 px-2.5 py-1 font-mono text-xs text-ink-soft"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
          <CodeBlock />
        </div>
      </section>

      {/* Install steps */}
      <section id="deploy" className="py-24">
        <div className="mx-auto max-w-6xl px-5">
          <SectionTitle
            kicker="Install"
            title="Yours in about five minutes"
            body="The deploy wizard provisions everything into your account - the same model that powers Traks installs."
          />
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {[
              {
                n: '01',
                title: 'Connect Cloudflare',
                body: 'Authorize the wizard with a scoped API token. It verifies your Workers Paid plan and picks your zone.',
              },
              {
                n: '02',
                title: 'Provision & onboard',
                body: 'Workers, D1, and R2 deploy automatically. One deep-linked click onboards your domain to Email Sending - SPF, DKIM, and DMARC records are created and locked for you.',
              },
              {
                n: '03',
                title: 'Send',
                body: 'The wizard detects your DNS going live, verifies the deployment end to end, and hands you your dashboard. Create a key and point your app at your new instance.',
              },
            ].map(s => (
              <div
                key={s.n}
                className="rounded-2xl border border-line-soft bg-white p-6 shadow-[0_1px_2px_rgba(30,25,18,0.04)]"
              >
                <p className="font-mono text-sm font-medium text-accent">{s.n}</p>
                <h3 className="mt-3 font-display text-xl font-semibold tracking-tight text-ink">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* v1 features */}
      <section id="features" className="border-t border-line-soft bg-paper-deep py-24">
        <div className="mx-auto max-w-6xl px-5">
          <SectionTitle
            kicker="Features"
            title="Everything the raw API doesn't give you"
            body="Cloudflare Email Service delivers the mail, signs DKIM, and manages IP reputation. Postey adds the product layer around it."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {V1_FEATURES.map(f => (
              <div
                key={f.title}
                className="rounded-2xl border border-line-soft bg-white p-6 shadow-[0_1px_2px_rgba(30,25,18,0.04)] transition hover:-translate-y-0.5 hover:shadow-[0_10px_24px_-12px_rgba(30,25,18,0.18)]"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent [&_svg]:h-5 [&_svg]:w-5">
                  {f.icon}
                </div>
                <h3 className="mt-4 text-base font-semibold text-ink">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Architecture */}
      <section id="architecture" className="py-24">
        <div className="mx-auto max-w-6xl px-5">
          <SectionTitle
            kicker="Architecture"
            title="Three workers, zero servers"
            body="Everything runs on Cloudflare primitives inside your account - the same hot/cold data design proven in Traks."
          />
          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                name: 'send',
                role: 'Public API worker',
                body: "Resend-compatible REST. Validates keys, checks suppressions, enforces idempotency, and delivers inline through Email Service - the response is Cloudflare's real answer.",
              },
              {
                name: 'send · events',
                role: 'Lifecycle consumer (same worker)',
                body: 'Consumes Email Sending delivery events - upgrades sent into delivered, bounced, or complained, feeds the suppression list, and fires your webhooks.',
              },
              {
                name: 'api + web',
                role: 'Dashboard',
                body: 'Single-operator sessions, domains, keys, templates, logs, the Inbox, and webhook config - metadata in D1, bodies and attachments in R2.',
              },
              {
                name: 'inbound',
                role: 'Email Routing handler',
                body: 'Parses and stores incoming mail - bodies and attachments - threaded to the send it answers via References; unsubscribe mail auto-suppresses, everything else unknown bounces.',
              },
            ].map(w => (
              <div
                key={w.name}
                className="rounded-2xl border border-line-soft bg-white p-6 shadow-[0_1px_2px_rgba(30,25,18,0.04)]"
              >
                <p className="font-mono text-sm font-semibold text-accent">{w.name}</p>
                <p className="mt-1 text-xs font-medium uppercase tracking-wide text-ink-soft">
                  {w.role}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">{w.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-line-soft bg-paper-deep py-24">
        <div className="mx-auto max-w-4xl px-5">
          <SectionTitle
            kicker="Pricing"
            title="Postey is software, not a middleman"
            body="The platform is yours to run. You pay Cloudflare for usage - nothing to us per email or per seat."
          />
          <div className="mt-12 overflow-hidden rounded-2xl border border-line-soft bg-white shadow-[0_1px_2px_rgba(30,25,18,0.04)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line-soft text-xs uppercase tracking-wide text-ink-soft">
                <tr>
                  <th className="px-5 py-4 font-semibold">Transactional volume</th>
                  <th className="px-5 py-4 font-semibold text-accent">Postey (CF usage)</th>
                  <th className="px-5 py-4 font-semibold">Resend</th>
                  <th className="px-5 py-4 font-semibold">Postmark</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {PRICING_ROWS.map(r => (
                  <tr key={r.volume}>
                    <td className="px-5 py-4 font-medium text-ink">{r.volume}</td>
                    <td className="px-5 py-4 font-mono font-semibold text-accent">{r.postey}</td>
                    <td className="px-5 py-4 font-mono text-ink-soft">{r.resend}</td>
                    <td className="px-5 py-4 font-mono text-ink-soft">{r.postmark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-center text-xs text-ink-soft">
            Approximate published pricing, August 2026. Postey = $5/mo Workers Paid plan + $0.35 per
            1,000 emails after the 3,000 included. The real difference isn't the bill - it's that
            your logs, templates, and reputation are yours.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-24">
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
      <section className="border-t border-line-soft bg-paper-deep py-24">
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
