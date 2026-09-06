# 09 — Build Plan

Six milestones. Each has tasks, acceptance criteria, and a first prompt for Claude Code. Do them in order. M0 ships publicly; M1–M4 ship to the pilot group; M5 is after campaign 1.

Time estimates assume Claude Code doing the build with one human reviewing. Real time: add the integration approvals (Meta app review, BankID broker contract, Swish Företag) which run in parallel and take weeks — start them in M0.

---

## M0 — Repo + landing page + waitlist  (week 1)

**Prompt:** *Read CLAUDE.md and docs/. Execute Milestone 0.*

Tasks
1. Scaffold Next.js 15 + TS strict + Tailwind + Prisma + Supabase client + next-intl + Vitest + Playwright + ESLint/Prettier. `pnpm` workspace, single app.
2. Prisma schema from `docs/04` — full schema, even for tables unused in M0 — and initial migration. Seed script skeleton.
3. `lib/money/rates.ts` with pilot defaults from `docs/05`; `lib/money/calc.ts` pure functions with tests covering every worked example in `docs/05`.
4. Landing page per `docs/01`: all sections, sv/en, estimator wired to `rates.ts`, waitlist form → `WaitlistEntry` + Resend email + referral link + OG image. `/brands` page + `BrandEnquiry`.
5. `/privacy` and `/terms` with draft text generated from `docs/07` (marked DRAFT).
6. PostHog events, Sentry with scrubbing, GitHub Actions CI, Vercel project (EU).
7. `Flag` table seeded with pricing floors/defaults; ops-only page to edit them (can be unstyled).

Acceptance
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green; CI green on PR
- [ ] Lighthouse mobile ≥ 95 on `/`
- [ ] Waitlist submit → row in DB → email received → referral link works and attributes `referredBy`
- [ ] Estimator output equals `calc.ts` for 400 / 1,500 / 5,000 views
- [ ] Under-18 not selectable; consent required
- [ ] Both locales complete (test fails on missing key)

Parallel human tasks: register Meta app + start review request; sign BankID broker sandbox; open Stripe; open Swish Företag; domain + email.

---

## M1 — Participant onboarding to VERIFIED  (weeks 2–3)

**Prompt:** *Execute Milestone 1. Onboarding per docs/02 §A1, participant state machine per docs/03 §3, Instagram + BankID per docs/06.*

Tasks
1. `lib/state/participant.ts` with all transitions + tests (every row of the state table, every failure).
2. Supabase Auth: phone OTP, Apple, Google. Role assignment. RLS policies for participant tables.
3. Instagram provider: real (behind env) + `ManualSocialProvider` + fake. OAuth flow, profile pull, token storage (encrypted), daily refresh job.
4. Onboarding screens 1–9, drop-off events, Creator-switch guide with reconnect, tier assignment, floor check.
5. Terms + disclosure quiz; training-consent (separate, default off); Swish number (validated, encrypted); web push subscription; done screen with referral.
6. BankID via broker sandbox: start/complete, hash+birthYear only, 18+ and duplicate rejection, `VERIFIED` transition. Gate is on first claim, but build the flow now and expose it at `/verify` for testing.
7. `/accounts` screen; `/settings` with consent toggle, data export job stub, delete-account request (30-day grace job).
8. Ops console: participants list/search/detail, flag/suspend/restore with reason (audited).

Acceptance
- [ ] A new user can go sign-up → onboarded on a phone in < 5 min using the fake Instagram provider
- [ ] Personal-account path lands in `CONNECTED_SCREENSHOT`; Creator path in `CONNECTED_API`
- [ ] BankID sandbox: happy path → `VERIFIED`; under-18 rejected; second user with same subject rejected
- [ ] No personnummer anywhere in DB, logs, or Sentry (grep the test run)
- [ ] Every participant transition has a test; illegal transitions throw
- [ ] Drop-off funnel visible in PostHog

---

## M2 — Campaigns + claim → approved  (weeks 4–5)

**Prompt:** *Execute Milestone 2. Campaign lifecycle docs/03 §2, placement P-01→P-07, money reservations docs/03 §4 and docs/05.*

Tasks
1. `lib/state/campaign.ts`, `lib/state/placement.ts` (P-01→P-07 only), `lib/money/ledger.ts` + `balances.ts` (views) with tests including all 8 edge cases that apply.
2. Ops: create Brand, invite brand user (magic link), campaign review/approve/return, force-transition with reason.
3. Brand: campaign builder 6 steps (docs/02 §B1) with floors from `Flag`s, template picker, fill-rate heuristic preview, disclosure guard, Stripe Checkout → webhook → `DEPOSIT` → `FUNDED`; invoice path gated by flag.
4. Go-live scheduler job (Fri 18:00 default) → `LIVE`; push to eligible participants.
5. Participant marketplace: tabs, cards with per-user estimate and eligibility badge, detail, BankID gate on first claim, claim with reservation, 48h timer + expiry job.
6. Upload with pre-check (format/size/duplicate hash; brand-safety as a stub returning OK unless a flagged keyword is in the campaign exclusions), position step with `OpsQueueEngine.candidates`, `GENERATING` → ops generation queue → upload result → `PARTICIPANT_REVIEW`.
7. Participant review (approve/regen ×3/move/swap/reject) with `PlacementEvent` logging; 24h expiry job.
8. Brand review Tier B queue + 24h auto-approve job; Tier A auto + 5% sample flag.
9. `APPROVED` screen with disclosure text, checklist, URL submit field (wires in M3).

Acceptance
- [ ] Brand can create, fund (Stripe test mode) and go live with a campaign; ops sees it; participant sees it with a correct estimate
- [ ] Claim reserves exactly `reservationOre` per `docs/05`; campaign shows spent/reserved/available correctly after claim, expiry, reject
- [ ] Budget exhaustion blocks new claims; reserved ones proceed (edge case 1)
- [ ] Duplicate image blocked (edge case 6)
- [ ] All timeouts fire in tests with fake clock and release reservations
- [ ] Tier B auto-approves at 24h; Tier A samples ~5%
- [ ] Every action writes `AuditLog`; every review action writes `PlacementEvent`

---

## M3 — Publish → hold → verify → wallet → payout  (weeks 6–7)

**Prompt:** *Execute Milestone 3. P-08→P-10, verification order docs/03 §1, settle per docs/05, payouts docs/06 §5.*

Tasks
1. URL submit → validate → `PUBLISHED`; API-tier post detection job (2h poll) using fake/real provider.
2. Hold job: schedules `hold-end` per content type; midpoint re-check for posts; Story view pull at hold end − 30 min.
3. Verification pipeline as an Inngest function: checks 1–6 in order; screenshot-tier path puts item in ops verification queue with OCR-assisted view entry; fraud score v0 (velocity vs `avgViews30d`, account age, engagement ratio; geo stub) → `FLAGGED` above threshold.
4. Settle: `SETTLE` / `PAYOUT_ACCRUE` / `TAKE` / `RELEASE_RESERVATION` entries in one transaction; `QUALIFIED` → `PAID` when accrued; earnings card image generation.
5. Wallet screen (pending/available/paid), transactions, earnings card gallery + share.
6. Ops payout batch: CSV export of balances ≥ 100 kr, mark paid → `PAYOUT_SENT`.
7. Strikes on `DELETED_EARLY`, `MEDIA_MISMATCH`, confirmed fraud; participant `FLAGGED`/`SUSPENDED` transitions.
8. Disclosure fix window (12h) with single re-verify.
9. Referral bonus job on referred user's first `QUALIFIED`.

Acceptance
- [ ] End-to-end with fakes: claim → … → paid, ledger sums match `docs/05` worked examples to the öre
- [ ] Missing disclosure → `REJECTED` unless fixed in window; ops cannot override (test asserts)
- [ ] Deleted-early → rejected + serious strike (edge case 5); spike → flagged, cap applied (edge case 2)
- [ ] Payout never exceeds reservation; remainder released
- [ ] Wallet balance = ledger sum; CSV export correct; marking paid creates `PAYOUT_SENT`
- [ ] Token expiry mid-hold pauses ≤72h then falls back (edge case 7)

---

## M4 — Brand dashboard + reconciliation + reports  (week 8)

**Prompt:** *Execute Milestone 4. Brand dashboard docs/02 §B2–B3, campaign close docs/03 §2, notifications matrix.*

Tasks
1. Campaign dashboard: spent/reserved/available, KPIs, effective CPM, daily chart, placements table with filters, breakdowns.
2. `EXHAUSTED`/`EXPIRED` → `RECONCILING` when last placement terminal; auto-reopen rule; PDF report (React-PDF) + email; 7-day dispute per placement → ops queue; refund (Stripe) or rollover → `CLOSED`.
3. Pause: brand/ops → honours open claims (edge case 4).
4. Full notifications matrix (push/email/Slack) with both languages.
5. Brand settings, billing history.
6. Ops: audit log viewer, flags UI, Slack alerts for fill 50/90/100%, fraud queue size, failed payouts.

Acceptance
- [ ] Dashboard numbers reconcile to ledger to the öre
- [ ] A campaign runs to `CLOSED` in tests with refund and with rollover
- [ ] Dispute flow works and cannot reverse a payout without ops decision on checks 2/3
- [ ] Every row of the notifications matrix has a test that the right recipient gets the right message
- [ ] Playwright smoke: participant happy path, brand happy path, ops verification path

**M4 done = pilot-ready.** Run campaign 1.

---

## M5 — After campaign 1: automate what cost the most hours  (weeks 9–12)

Order by measured ops time, but expected:
1. `HostedInpaintEngine` behind the engine interface; ops queue becomes review-only
2. Real Instagram insights + post detection in production (post app review)
3. Swish Payouts API
4. Fraud score v1 with cross-campaign patterns; geo from API where available
5. Fill-rate model from campaign-1 data replacing the heuristic
6. Training export job (consented, anonymised) → bucket for Parallel
7. Second city + MitID (via same broker) when Stockholm has 1,000+ active participants and 3 campaigns

Update `docs/05` with the real numbers from campaign 1 before touching pricing code.

---

## Not in scope (say no until after campaign 3)

Native apps · TikTok insights · agency multi-brand accounts · self-serve brand signup without ops · A/B tests on placements · any second country · any objective other than awareness.
