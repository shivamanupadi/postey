# Postey

**Self-hosted email for apps and agents, installed into your own Cloudflare
account.**

Postey is two products in one dashboard: **Send** — a Resend-compatible
transactional email API — and **Inbox** — replies and inbound mail, threaded
to the sends they answer. A deploy wizard on the marketing site provisions
prebuilt Worker bundles, D1 migrations, and the dashboard directly into your
Cloudflare account, so your email infrastructure runs entirely under your own
control. Same install model as [Traks](https://github.com/shivamanupadi/traks).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Built on Cloudflare](https://img.shields.io/badge/built%20on-Cloudflare-orange)

## Highlights

- **Resend-compatible API** — drop-in `/emails` endpoint that works with
  Resend's SDKs; switch providers by changing the base URL and key.
- **Two-way email** — every sending domain can also receive. Replies are
  parsed, stored with their attachments, and threaded to the outbound send
  they answer — rendered mail-client-clean (inline images included) in the
  same dashboard.
- **Agent-native** — a built-in MCP server gives coding agents their own
  email tools: send, plus `list_replies` / `get_reply` /
  `get_reply_attachment` / `reply_to` to close the loop on conversations,
  files included.
- **Honest delivery** — sends go inline through Cloudflare Email Service, so
  the API response is Cloudflare's real answer (200 sent; 429 with
  `Retry-After` when the reputation-gated cap hits). No queue pretending a
  send succeeded.
- **The product layer Email Service lacks** — API keys (hashed,
  domain-scopable), idempotency, an email log with rendered previews and
  per-recipient status, templates with test sends, an auto-fed suppression
  list, and signed outbound webhooks.
- **Self-hosted, your account, your data** — everything lives in your
  Cloudflare account: Workers, D1, R2. Postey has no server-side access to
  your mail.

## How it works

### Send

[Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
(beta; Workers Paid: 3,000 emails/mo included, then $0.35/1k) handles
delivery, DKIM signing, and IP reputation. Postey adds the product layer on
top:

- Resend-compatible REST API (including `/emails` for their SDKs)
- API keys — hashed at rest, scopable per domain
- Idempotency — retrying a failed send re-attempts it safely
- Email log with rendered previews and per-recipient delivery status
- Templates with test sends
- Suppression list, auto-fed by bounces, complaints, and unsubscribe mail
- Signed outbound webhooks for delivery events, with one-click test deliveries
- MCP server for agents

Deliberately **not** built: scheduling, queues, and quota modeling — the
reputation-gated daily cap is per-account and unknowable, so Cloudflare's
own rejection is the only honest signal, and Postey passes it straight
through.

### Inbox

One catch-all Email Routing rule per zone (a deliberate, human step — Postey
never touches your mail routing itself) delivers to the inbound Worker.
Addresses like `support@` become instant rows in Postey; unknown addresses
keep bouncing. Replies are parsed (postal-mime), stored (D1 + R2, attachments
included), threaded to the outbound send they answer via `References`, and
announced with an `email.reply.received` webhook. The dashboard renders the
conversation inline — sanitized HTML, `cid:` images resolved, quoted history
collapsed — and replies as the receiving address through the same send
pipeline; agents do the same over MCP. Setup is verified honestly: a DNS
check confirms Email Routing is enabled, and a self-probe (the instance
emails itself) proves the catch-all really delivers to the worker.

## Repository layout

```
apps/
  home/
    web        postey.app marketing site + deploy/update/destroy wizard UI
    api        deploy wizard backend, instance registry, release manifests
  platform/    what gets installed into the customer's Cloudflare account
    api        dashboard API — sessions, domains, keys, templates, logs, Inbox
    send       public send API Worker (Resend-compatible REST + MCP server)
    inbound    Email Routing handler — stores inbound mail, threads replies,
               auto-suppresses unsubscribes
    web        dashboard SPA — Send and Inbox behind one product switcher
packages/
  shared       types + zod schemas for send payloads and webhook events
installer/     build-release / upload-release / release tooling
```

Monorepo managed with Bun workspaces + Turborepo. Requires Node ≥ 20.

## Installing (deploy wizard)

The wizard on the marketing site installs Postey into your Cloudflare
account. Constraints to know:

- **Workers Paid plan required** — the wizard verifies the subscription
  before proceeding.
- **Domain onboarding is one manual step** — Email Sending has no public API
  yet (dashboard-only while in beta). The wizard automates everything else,
  deep-links the step (`dash.cloudflare.com → Email Service → Onboard
  Domain`), detects completion by polling the zone's DNS for the locked
  `cf-bounce` records, and verifies with a free send to a verified address.
- **Inbox's catch-all rule is likewise manual by design**, guided from the
  dashboard's Inbox first-run screen — Postey never modifies your mail
  routing on its own.

## Development

```sh
bun install
bun run dev          # all apps on :6010-:6014
bun run build
bun run type-check
bun run release:build && bun run release:upload   # publish a release
```

## Contributing

Issues and pull requests are welcome. Please run `bun run build` and
`bun run type-check` before opening a PR and keep changes focused.

## License

[MIT](LICENSE) © 2026 Shivaprasad Manupadi
