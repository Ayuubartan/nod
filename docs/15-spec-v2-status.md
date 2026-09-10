# 15 — Status against the v2.0 platform spec

The "Creator Campaign Tracking Platform — Production Technical Specification"
(v2.0, 2026-09-09) is the source document for `docs/14`. This file is the other
direction: the spec's own two checklists — §14 *MVP acceptance criteria* and §32
*Launch checklist* — scored against the code as it stands, with the evidence.

Written 2026-09-10 against `4f90711`. Where `docs/14` deliberately departs from the
spec, that document wins and §8 there says why; those are marked **by decision**, not
as gaps.

The short version: the loop the spec calls the golden path is built. What is missing is
almost entirely **credentials and a load test**, not code.

## §14 — MVP acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Creator connects an account without giving a password | **Built, inert** | `lib/social-oauth.ts`, read-only scopes. `NOD_FAKE_PROVIDERS=1` is set in production, so today it simulates; real connect needs the Meta/TikTok apps. |
| 2 | Platform can prove a submitted post belongs to that creator | **Built** | `lib/clips/verify.ts`; `docs/14` D5 requires a `CONNECTED_API` account on the post's platform — ownership is `author == connected account`, never a handle string. |
| 3 | Initial snapshot stored, metrics refreshed automatically | **Built, inert** | `Submission.initialViews`, `SubmissionSnapshot`, `submissionTrackScheduler` (`inngest/clips.ts`). Needs the Inngest keys to actually fire. |
| 4 | The same post cannot be paid twice for one campaign | **Built** | `@@unique([campaignId, platform, postId])` on `Submission`; `LedgerEntry.externalRef @unique`. Both enforced by Postgres, not by application logic. |
| 5 | A campaign cannot settle more than its funded budget | **Built** | Reservation at submit (`docs/14` D2), `campaignBalance()` inside the transaction. |
| 6 | Moderator can approve / reject / hold, auditably | **Built** | `opsApproveSubmission`, `opsRejectSubmission` in `app/(ops)/actions.ts`; `/ops/submissions`; every decision writes `AuditLog`. |
| 7 | Balance reproducible from ledger, not a mutable field | **Built** | `LedgerEntry` append-only, balances summed. CLAUDE.md rule 2. |
| 8 | Revoked/expired connection stops tracking safely, can reconnect | **Partial** | Backoff and pause exist (`lib/state/submission.ts`: `consecutiveFailures`, `trackingPausedAt`). Whether a *revoked* token specifically raises a reconnect prompt to the creator is **not verified**; it needs a live provider to test against. |
| 9 | Provider failures retry without duplicate payouts | **Built** | `SubmissionSnapshot @@unique([submissionId, bucket])` makes a replayed job idempotent — the spec's own §22 suggestion; plus `claimOnce` and the unique `externalRef`. |
| 10 | Fraud signals can hold a payout for review | **Built** | Risk bands in `lib/clips/tracking.ts` → `holdSubmission`; `HELD` is a real state with its own ops queue and reminder job. |

## §32 — Launch checklist

| Item | Status |
|---|---|
| Join without connecting an account first, unless campaign requires it | **Built** — join is DB-only (`docs/14` D7); no provider call in the join path, ever |
| Connection reusable across campaigns, tokens encrypted at rest | **Built** — `SocialAccount` + `lib/crypto.ts` (AES-256-GCM) |
| Fast submit, async verification visible to the creator | **Built** — submit does URL parse + reservation synchronously, the rest in Inngest; creator sees submission state |
| Queue consumers idempotent, dead-letter handling | **Built** — idempotent by constraint; Inngest owns retries/DLQ |
| Provider quota dashboards and alerts before opening a campaign | **Not built** — circuit-breaker flags per platform exist (`lib/flags.ts`, `docs/14` §4); a quota dashboard does not |
| Spend cannot exceed budget under concurrent validation | **Built** — see §14 #5 |
| Creator sees estimated vs validated vs payable vs paid | **Built** — estimate capped at the reservation, shown next to the validated number and freshness |
| Fraud holds never silently erase earnings; every action has a reason | **Built** — reject requires a reason code and a note; `HELD` preserves the reservation |
| Ops can pause joins, submissions, tracking, payouts independently | **Built** — per-campaign pause/resume, audited; tracking via the platform breaker flag |
| Load tests at 20k memberships / 60k submissions | **Never run** — the design targets it (`docs/14` §7) and nothing has tested it |
| Terms, privacy, disclosure, provider terms, payout/KYC reviewed | **Partial** — disclosure is enforced non-waivably (CLAUDE.md rule 5); provider developer terms are unreviewed because the apps do not exist yet |

## By decision, not gaps

From `docs/14` §8 and D1–D9: no Kafka/Redis/worker fleet (Inngest + Postgres carry the
pilot), no YouTube in phase 1, no waitlisted memberships, and the creator's "estimated
earnings" is explicitly an estimate rather than a promise.

## What is actually left

1. **Meta + TikTok developer apps**, then unset `NOD_FAKE_PROVIDERS`. Both need app
   review before non-test users can connect. Read scopes only.
2. **Inngest keys** — until `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` exist, the
   tracking scheduler, validation and every timeout job are written but never fire.
   This is the single biggest gap between "built" and "working".
3. **A load test** at the design point (spec §29). Nothing here has met 20k anything.
4. **Provider quota visibility** for ops (spec §26/§32).
5. The reconnect path for a revoked token (§14 #8), verifiable only against a live
   provider.
