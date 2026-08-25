# Postey

Self-hosted transactional email & newsletters, installed into your own
Cloudflare account. Same install model as [Traks](../traks): a deploy wizard on
the marketing site provisions prebuilt worker bundles, D1 migrations, and the
dashboard into the customer's account.

## Monorepo

```
apps/
  home/
    web        postey.app marketing site + deploy wizard UI (this exists first —
               it defines the product scope)
    api        deploy wizard backend, instance registry, release manifests
  platform/    what gets installed into the customer's Cloudflare account
    api        dashboard API — Better Auth, D1, domains, API keys, templates, logs
    send       public send API worker (Resend-compatible REST) → Queues → Email Service
    inbound    Email Routing email() handler: replies, unsubscribes, inbound webhooks
    web        dashboard SPA
packages/
  shared           types + zod schemas for send payloads and webhook events
  sender-adapters  SendProvider interface: cloudflare (v1), ses (v2 bulk/newsletters)
installer/         build-release / upload-release / release tooling (Traks pattern)
```

## Product scope

**v1 — transactional.** Cloudflare Email Service (beta, Workers Paid: 3,000
emails/mo included, then $0.35/1k) does delivery, DKIM/ARC signing, and IP
reputation. Postey adds the product layer it lacks: Resend-compatible REST API,
API keys, idempotency, scheduled sends, quota-aware queueing (the CF daily cap
is reputation-gated and opaque — learned from 429s, never dropped), email log
with rendered previews, templates, suppression list (auto-fed from the send
API's per-recipient bounce response), outbound webhooks, inbound routing.

**v2 — newsletters.** Subscribers, double opt-in, segments, campaigns,
open/click analytics, one-click unsubscribe. Bulk sends go through a pluggable
provider (Amazon SES first — CF Email Service is transactional-only until
their bulk tooling ships).

## Install constraints (wizard)

- Requires the Workers Paid plan — the wizard verifies the subscription before
  proceeding.
- Domain onboarding to Email Sending has **no public API yet** (dashboard-only
  while in beta). The wizard automates everything else, deep-links the one
  manual step (`dash.cloudflare.com → Email Service → Onboard Domain`), then
  detects completion by polling the zone's DNS for the locked `cf-bounce`
  records, and verifies with a free send to a verified address.

## Development

```
bun install
bun run dev      # home web on :6013
bun run build
```
