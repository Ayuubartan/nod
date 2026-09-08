# NOD — Claude Code instructions

You are building **NOD**, a distributed social advertising marketplace. Brands fund campaigns; everyday people place those brands naturally inside content they were already going to post, publish it disclosed to their own accounts, and get paid on verified views. NOD keeps a spread on the media spend.

Read `docs/` in numeric order before writing code. `docs/09-build-plan.md` is the task list — work through milestones in order and do not skip ahead.

## Naming

**NOD** is the internal codename and stays in the repo, docs, env vars (`NOD_*`) and
cookies. The public brand is **Boogaa** (joinbooga.se): every visible string uses
`lib/brand.ts` or the i18n files. Never write "NOD" into user-facing copy.

## Non-negotiables

1. **The state machines in `docs/03-workflows.md` are the source of truth.** Every Campaign, Placement, Participant and Money transition must be a named function that validates the current state, applies the transition, writes an `AuditLog` row, and emits an event. No ad-hoc status updates anywhere.
2. **Money is integers in öre (SEK × 100).** Never floats. Never string math. All ledger entries are append-only; balances are derived by summing, never stored as a mutable number.
3. **Budget is reserved at claim.** A claim that cannot reserve its expected payout fails. Reservations release on timeout, reject, or expiry. See `docs/05-pricing.md` for the reservation formula.
4. **Every timed state has a timeout job.** If you add a state, add its expiry job in `inngest/` the same commit.
5. **Disclosure is a payable condition.** Verification check #2 is disclosure presence. A placement without it is `REJECTED`, never `QUALIFIED`. No overrides, including for ops.
6. **NOD never posts on a user's behalf.** No write scopes to any social API. Participants publish themselves.
7. **Minimum data.** Store only what `docs/07-compliance.md` allows. Personnummer is never stored in plaintext; store BankID `subject` hash + `birth_year` + `verified_at`.
8. **Two languages from day one.** All user-facing strings go through `i18n` (sv, en). No hardcoded copy.
9. **Soft delete only.** `deleted_at` on every table. Nothing is hard-deleted except by an explicit GDPR erasure job.

## Stack (see docs/08-tech-stack.md for why)

Next.js 15 (App Router, TypeScript strict) · Tailwind · Prisma + PostgreSQL (Supabase) · Supabase Auth + Storage · Inngest for jobs · Stripe for brand deposits · Resend for email · PostHog · Sentry · Vercel.

## Repo layout

```
app/
  (marketing)/        landing page, waitlist, brand enquiry
  (participant)/      onboarding, marketplace, placements, wallet
  (brand)/            campaign builder, dashboard, review queue
  (ops)/              internal console: review, fraud, payouts, campaigns
  api/                webhooks (stripe, criipto, meta), cron endpoints
lib/
  state/              one file per lifecycle: campaign.ts, placement.ts, participant.ts, money.ts
  money/              ledger, reservations, payout calc (pure functions, 100% tested)
  integrations/       instagram.ts, bankid.ts, stripe.ts, swish.ts, engine.ts
  i18n/
prisma/
inngest/              timeout jobs, verification pipeline, payout batches
tests/
docs/                 these specs
```

## Conventions

- Server Actions for mutations; every action validates input with `zod` and checks role.
- One Prisma transaction per state transition.
- Pure functions in `lib/money` and `lib/state` have unit tests (Vitest) before UI is built on them.
- Feature flags via a `flags` table, not env vars, so ops can toggle Tier A/B review, floors, etc.
- Commit messages: `feat(placement): P-05 participant review`, `fix(money): reservation release on claim expiry`. Reference the step IDs from `docs/03-workflows.md`.
- When something in the docs is ambiguous, pick the simpler option, implement it, and leave a `// DECISION:` comment explaining the choice. Do not stop to ask unless it touches money, compliance, or data retention.

## Definition of done for a milestone

- All acceptance criteria in `docs/09-build-plan.md` pass
- State transitions covered by tests, including every failure path
- `pnpm typecheck && pnpm lint && pnpm test` green
- Seed script updated so the next milestone has data to work with
