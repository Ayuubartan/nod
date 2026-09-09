# 14 — Clip campaigns (CPM on creators' own posts)

A second campaign kind next to the AI product-placement flow. A brand publishes a
brief; creators join, post natively on their own TikTok or Instagram, paste the public
link, and get paid per validated thousand views. NOD verifies ownership through the
creator's own read-only connection, tracks the post on an adaptive cadence, validates
after a window, and settles into the same append-only ledger the placement flow uses.

Adapted from the "Creator Campaign Tracking Platform" spec (v2.0, 2026-09-09). Where
that spec and this repo disagree, this document wins; the decisions are marked.

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | `Campaign.kind = PLACEMENT \| CLIP`. One Campaign table, one budget, one ledger, one brand dashboard shell. | The money, OAuth, fraud, ops and compliance layers are identical; only the creator loop differs. |
| D2 | **Budget is reserved at submission** (`min(perPostCap, available)`), first-come. When available hits 0 the post is still accepted and tracked but marked `budgetExhausted` — visibly "not payable". Reservations released by rejects are **topped up** to the oldest under-reserved submissions in `submittedAt` order. | Keeps CLAUDE.md rule 3 (budget reserved before payout) and gives creators a truthful "up to X kr" the moment they submit. No fake availability. |
| D3 | Phase 1 platforms: TikTok and Instagram together. YouTube is out of scope. | Both providers already exist read-only. |
| D4 | Stays on Vercel + Inngest + Neon. The tracking scheduler is a Postgres query over `Submission.nextCheckAt`; per-provider Inngest functions carry the concurrency/throttle keys; the circuit breaker is a flag per platform. | No new infrastructure for the pilot; the scheduler is a cron, the fan-out is durable. |
| D5 | A CLIP submission requires a `CONNECTED_API` account on the post's platform. No screenshot tier. | Ownership must be proven by the provider (`author == connected account`), never by a handle string. |
| D6 | Disclosure remains a payable condition (CLAUDE.md rule 5). Caption must contain the disclosure phrase or `#reklam`/`#ad` plus the campaign's required hashtags. Missing → 12 h fix window, then `REJECTED`. Ops cannot override. | Swedish marketing law; identical to the placement flow. |
| D7 | Join is DB-only. No provider call in the join path, ever. Submit does URL parsing + reservation synchronously and everything else in Inngest. | Spec non-negotiable 1; keeps p95 of join/submit under the SLO at 20k creators. |
| D8 | Stories are not accepted (no stable public URL, 24 h lifetime). Reels, posts, TikTok videos and photo posts are. | Tracking needs a stable id for the whole validation window. |
| D9 | `perPersonCap` is reused as "max submissions per creator per campaign" and `perPlacementMax` as the per-post payout cap. | Same semantics, no duplicate columns. |

## 1. Creator loop

```
browse → join (JOINED)            no provider call, checks: state LIVE, kind CLIP, platform connected,
                                  not blocked/suspended, joinCap not reached, joins not paused
       → post natively            NOD never posts (rule 6)
       → submit URL (RECEIVED)    parse → (campaign, platform, postId) unique → cap per creator →
                                  reserve min(cap, available) → audit → emit submission/received
       → verify (Inngest)         ownership via provider with the creator's token → publish window →
                                  disclosure + hashtags → initial snapshot → TRACKING | FIX_DISCLOSURE | REJECTED
       → track                    adaptive cadence (section 4) until validationEndsAt
       → validate (VALIDATING)    final check → fraud → QUALIFIED (settle) | HELD (ops) | REJECTED
       → paid                     PAYOUT_ACCRUE lands in the wallet; Swish batch as today
```

## 2. State machines (also in docs/03 §5)

### CampaignMembership

| State | Enters on | Exits |
|---|---|---|
| `JOINED` | `joinCampaign()` | `LEFT` (creator), `SUSPENDED` (fraud disposition), `BLOCKED` (ops) |
| `LEFT` | creator leaves; existing submissions keep tracking | `JOINED` on re-join (same row) |
| `SUSPENDED` | fraud `SUSPEND_CREATOR` | ops → `JOINED` |
| `BLOCKED` | ops | terminal |

### Submission

| ID | State | Owner | Enters on | Timeout → | Exits to |
|---|---|---|---|---|---|
| S-01 | `RECEIVED` | Participant | URL parsed, reservation written | verify job SLA 15 min; 24 h without result → ops | `TRACKING` / `FIX_DISCLOSURE` / `REJECTED` |
| S-02 | `FIX_DISCLOSURE` | Participant | ownership ✓ but caption lacks disclosure/required tags | 12 h → `REJECTED` `NO_DISCLOSURE` (release) | `TRACKING` on re-check |
| S-03 | `TRACKING` | System | initial snapshot stored | `validationEndsAt` → `VALIDATING` | `REJECTED` (deleted/private → strike) |
| S-04 | `VALIDATING` | System (+Ops on flag) | window ended, final check | 24 h target | `QUALIFIED` / `HELD` / `REJECTED` |
| S-05 | `HELD` | Ops | fraud band ≥ 60 or budget/ownership anomaly | 7 d → ops reminder | `QUALIFIED` / `REJECTED` |
| S-06 | `QUALIFIED` → `PAID` | System | settled to ledger | wallet immediate | terminal |

Terminal: `PAID`, `REJECTED`. Every terminal non-paid state releases the reservation and
triggers a top-up pass for the campaign (D2).

Reject reasons: `NOT_OWNER`, `NOT_FOUND`, `OUTSIDE_WINDOW`, `NO_DISCLOSURE`, `DELETED_EARLY`,
`FRAUD`, `OPS_REJECTED`, `DUPLICATE`.

## 3. Verification (S-01), stop at first fail

1. Membership `JOINED`, campaign `LIVE`/`FILLING`/`EXHAUSTED` (exhausted still tracks — D2).
2. Provider resolves `postId` **among the connected account's own media** using the
   creator's token. Not found → `NOT_OWNER` (indistinguishable from deleted; the message
   tells the creator to check the account and the link).
3. `publishedAt` inside `[campaign.liveAt − 24 h, campaign.endsAt]` → else `OUTSIDE_WINDOW`.
4. Caption contains disclosure (campaign phrase, `#reklam`, `#ad`, `#annons`, `#samarbete`
   or the platform's paid-partnership label) **and** every `requiredHashtags` /
   `requiredMentions` entry → else `FIX_DISCLOSURE` (12 h).
5. Initial snapshot (`views`, `likes`, `comments`, `shares`) → `initialViews`. Eligible
   views are counted from submission onward: `eligibleViews = latestViews − initialViews`.

## 4. Tracking cadence

| Post age at check | Next check in | Priority |
|---|---|---|
| < 6 h | 10 min | 0 |
| < 24 h | 30 min | 1 |
| < 3 d | 60 min | 2 |
| < 14 d | 4 h | 3 |
| ≥ 14 d | 24 h | 4 |

- `submission-track-scheduler` runs every 5 min: selects `TRACKING` rows with
  `nextCheckAt ≤ now` and `(queuedAt IS NULL OR queuedAt < now − 15 min)`, ordered by
  priority then `nextCheckAt`, limit 2 000, groups by `(platform, socialAccountId)`, chunks
  (TikTok 20 ids per `video/query`, Instagram 10 per batch) and sends one
  `submission/track.batch` event per chunk. `queuedAt` is stamped before send.
- `submission-track-tiktok` / `submission-track-instagram` process one chunk each, with
  `concurrency` and `throttle` keyed per platform. A 429 raises `RetryAfterError`.
- Circuit breaker: flags `tracking.tiktok.enabled` / `tracking.instagram.enabled`. Off →
  the scheduler skips the platform; rows keep their `nextCheckAt` and catch up when re-enabled.
- Every observation writes a `SubmissionSnapshot` with `bucket = floor(observedAt / 5 min)`;
  `@@unique([submissionId, bucket])` makes replays idempotent.
- `latestViews` is monotonic. A decrease beyond 2 % is recorded as a risk factor, not a
  reset. Two consecutive "not returned" observations → `REJECTED` `DELETED_EARLY` +
  serious strike (placement edge case 5). A dead token pauses the account's submissions
  (`nextCheckAt += 6 h`) and notifies the creator; they resume on reconnect.
- Failures back off: `consecutiveFailures` ≥ 3 doubles the delay, capped at 24 h.

## 5. Validation and settlement

At `validationEndsAt` (= `submittedAt + campaign.validationHours`, default 168):

1. One final metrics pull (same worker; a failure retries, never skips).
2. `assessFraud()` with `views = eligibleViews`, engagements from the last snapshot, the
   account's baseline, and prior history. Plus clip-specific factors from the snapshot
   series: single-interval jump > 50 % of total on > 5 000 views, and flat identical
   increments. Bands per spec: 0–29 allow · 30–59 allow, monitor · 60–79 `HELD` ·
   80–100 `REJECTED` `FRAUD` (+ strike; ≥ 2 fraud rejects → membership `SUSPENDED`).
3. `qualifiedViews = eligibleViews × geoFactor × (1 − fraudDiscount)`;
   `settle(template, qualifiedViews, reservationOre)` from `lib/money/calc.ts` — payout
   never exceeds the reservation; the remainder is released. Entries carry
   `submissionId`; `externalRef = "settle:submission:<id>"` makes the write idempotent.
4. `budgetExhausted` submissions with `reservationOre = 0` qualify with a 0 kr payout and
   the creator sees exactly that; no promise was made.

## 6. Ops

- `/ops/submissions`: queue of `HELD` first, then `VALIDATING` older than 24 h, then
  `RECEIVED` older than 1 h. Actions: approve, reject (reason), replay verification.
  Approving cannot bypass disclosure — a `NO_DISCLOSURE` reject is final.
- Per-campaign controls: pause joins, pause submissions (flags on the Campaign row).
- Ownership re-verification on `HELD` uses the same provider path as S-01.

## 7. Scale notes (20 k creators / 60 k submissions per campaign)

- Join and submit touch only Postgres; both run in one transaction each with a unique
  constraint doing the racing (`@@unique([campaignId, userId])`,
  `@@unique([campaignId, platform, postId])`).
- Reservation uses `campaignBalance()` inside the transaction as the placement claim does;
  over-reservation under concurrency is bounded by one in-flight submission per creator and
  corrected by the top-up pass.
- Aggregates for the brand dashboard are computed from `Submission` columns
  (`latestViews`, `eligibleViews`, `state`) with indexes on `(campaignId, state)`; no
  provider call ever serves a dashboard.
- Snapshots: ~60 k submissions × ~150 checks over 7 days ≈ 9 M rows per big campaign.
  Retention: raw snapshots 90 days after terminal, then thinned to daily.

## 8. What the spec asked for that is intentionally not here

- Kafka / Redis / separate worker fleets — Inngest + Postgres carry the pilot (D4).
- YouTube — not in phase 1 (D3).
- Waitlisted memberships — a full campaign returns `full`; no queue positions are shown
  because none would be real.
- Creator "estimated earnings" from live views are shown as an estimate, capped at the
  reservation, next to the validated number and the freshness timestamp.
