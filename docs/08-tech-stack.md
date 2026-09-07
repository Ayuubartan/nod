# 08 — Tech Stack

## Summary

Modular monolith. One Next.js app, one Postgres, one job runner. Boring on purpose: the risk in NOD is market and compliance, not infrastructure. Everything below can carry the first 50k participants and 100 concurrent campaigns without re-architecture.

## Recommendation (confidence: high)

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15, App Router, TypeScript strict | One codebase for marketing, participant, brand, ops; Server Actions for mutations; Vercel deploy in minutes |
| UI | Tailwind + a small shadcn/ui set | Fast, consistent, accessible defaults |
| DB | PostgreSQL on Supabase | Managed Postgres + Auth + Storage + RLS in one; EU region (Frankfurt/Stockholm) |
| ORM | Prisma | Schema in `docs/04`; migrations; Claude Code is fluent in it |
| Auth | Supabase Auth (phone OTP, Apple, Google, magic link) | Covers participants and brand users; no custom password flows |
| Storage | Supabase Storage with image transforms | Originals, versions, screenshots; signed URLs; EU region |
| Jobs | Inngest | Timeouts, verification pipeline, token refresh, payout batches; retries and cron built in; runs on Vercel |
| Payments in | Stripe (Checkout + Invoicing) | Cards and invoices; webhooks; refunds |
| Payments out | Manual Swish → Swish Payouts API | See integrations |
| Identity | BankID via broker (Criipto/Signicat/Scrive) | Nordic coverage from one integration |
| Email | Resend + React Email | Transactional, both languages |
| Push | Web Push (VAPID) | PWA; no app store needed for pilot |
| Analytics | PostHog (EU cloud) | Funnels, flags could also live here but keep flags in DB |
| Errors | Sentry | Scrubbing rules required |
| i18n | `next-intl` | sv/en, typed keys |
| Validation | zod | Every action input, every webhook payload |
| Tests | Vitest (unit), Playwright (3 smoke flows) | Money and state functions at 100% |
| Hosting | Vercel (EU) | Preview per PR |

## Alternatives considered

| Instead of | Why not now |
|---|---|
| Native app (Expo) | Doubles surface area; pilot audience arrives from Instagram in-app browsers anyway; PWA + push is enough. Revisit after campaign 3. |
| Separate API service (NestJS/Go) | No second consumer of the API yet; Server Actions + Inngest cover it. Extract when a mobile app or partner API exists. |
| Queue infra (Redis/BullMQ) | Inngest gives durable, scheduled, retried jobs without running Redis. |
| Custom auth | No. |
| Storing money as decimal | No. Integers in öre, ledger only. |

## Repo structure

```
nod/
  app/
    (marketing)/         page.tsx, brands/, waitlist/, privacy/, terms/
    (participant)/       onboarding/, campaigns/, placements/, wallet/, accounts/, invite/, settings/
    (brand)/             campaigns/, campaigns/new/, campaigns/[id]/, settings/
    (ops)/               campaigns/, generation/, verification/, payouts/, participants/, brands/, flags/, audit/
    api/                 webhooks/stripe, webhooks/criipto, webhooks/meta, inngest/
  lib/
    state/               campaign.ts placement.ts participant.ts money.ts  (+ tests)
    money/               rates.ts calc.ts ledger.ts balances.ts             (+ tests)
    integrations/        instagram/ tiktok/ bankid/ stripe/ swish/ engine/  (interface + real + fake + manual)
    auth/                roles, guards
    i18n/                sv.json en.json
    db.ts                prisma client
  inngest/
    timeouts/            claim-expiry.ts review-expiry.ts publish-expiry.ts brand-review-expiry.ts
    pipeline/            hold-end.ts verify.ts settle.ts
    scheduled/           token-refresh.ts campaign-golive.ts payout-batch.ts floor-reevaluate.ts
  emails/
  prisma/                schema.prisma migrations/ seed.ts
  legal/                 drafts from docs/07
  tests/
  docs/
```

## Environment

```
DATABASE_URL, DIRECT_URL
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY
META_APP_ID, META_APP_SECRET
BANKID_BROKER_CLIENT_ID, BANKID_BROKER_CLIENT_SECRET, BANKID_SUBJECT_SALT
RESEND_API_KEY
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
POSTHOG_KEY, SENTRY_DSN
ENCRYPTION_KEY   # for swishNumber, tokens (AES-GCM, key from env, never in DB)
```

`.env.example` committed; secrets in Vercel. Fakes activate when a provider key is absent (`NOD_FAKE_PROVIDERS=1` in dev/test).

## Security baseline

- RLS on all participant/brand tables; ops bypass via service role in server code only
- Role check in every Server Action (`requireRole('BRAND', brandId)`)
- Webhook signature verification on every inbound webhook; idempotency by external ID
- Rate limits on auth, waitlist, claim
- Encrypt at rest: tokens, Swish number
- No secrets to the client; no BankID data in logs; Sentry scrubbing configured before first deploy

### Status (2026-09-07)

| Item | Where |
|---|---|
| RLS | `prisma/migrations/20260907120000_rls/` — 51 policies. `Identity` deliberately has **none**, so only the service role can read the BankID hash; `LedgerEntry` has no UPDATE or DELETE policy for any role, making append-only a database guarantee rather than only an application rule |
| Role checks | `lib/auth.ts`; every Server Action begins with `requireParticipant` / `requireBrandUser(brandId)` / `requireOps` |
| Webhook signatures | `app/api/webhooks/stripe` (Stripe SDK), `app/api/webhooks/meta` (HMAC-SHA256, `timingSafeEqual`). Idempotency by `LedgerEntry.externalRef`, which is unique |
| Rate limits | `lib/rate-limit.ts` on waitlist, brand enquiry, sign-up, BankID start, claim and upload |
| Encryption at rest | `lib/crypto.ts`, AES-256-GCM |
| Scrubbing | `lib/scrub.ts`, used by both `lib/logger.ts` and `sentry.shared.ts`. Redacts by key **and** by value scan, so a personnummer inside a free-text error is caught too. Tested in `tests/scrub.test.ts` |

Session replay is deliberately disabled: participants upload personal photos and the ops
console shows verification screenshots.

## CI (GitHub Actions)

`pnpm install → prisma generate → typecheck → lint → vitest → playwright smoke (against preview)`. Block merge on red. Migrations run on deploy via Vercel build step.

## Observability

Structured JSON logs with `requestId`, `userId`, `placementId`. RED metrics on Server Actions via PostHog + Sentry performance. Ops Slack channel gets: fill thresholds, fraud queue size, failed payouts, failed webhooks.

Implemented in `lib/logger.ts`: context travels in `AsyncLocalStorage`, so a function
deep in a call stack does not thread a `requestId` through every signature. `measured()`
wraps an action and logs rate, errors and duration. Every line goes through the scrubber
before it is written — that is the reason this exists rather than bare `console.log`.
