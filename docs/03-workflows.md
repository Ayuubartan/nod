# 03 — Workflows (source of truth)

Four state machines. Each transition is a named function in `lib/state/<lifecycle>.ts`:

```ts
transition(entityId, event, actor, payload): Promise<Result>
// validates from-state, applies, writes AuditLog, emits Inngest event, all in one transaction
```

Every timed state has a matching Inngest job in `inngest/timeouts/`. Actors: `PARTICIPANT` · `BRAND` · `SYSTEM` · `OPS`.

---

## 1. Placement

The core unit. One Placement = one Participant + one SocialAccount + one Campaign + one piece of content.

| ID | State | Owner | Enters on | Timeout → | Exits to |
|---|---|---|---|---|---|
| P-01 | `CLAIMED` | Participant | claim(): eligibility ✓, verified ✓, cap ✓, **reservation ✓** | 48h → `EXPIRED` (release) | `UPLOADED` |
| P-02 | `UPLOADED` | Participant | upload passes pre-check (format, size, brand-safety, duplicate hash) | (shares P-01 clock) | `POSITIONED` |
| P-03 | `POSITIONED` | Participant | surface + product chosen | (shares P-01 clock) | `GENERATING` |
| P-04 | `GENERATING` | System/Ops | engine job started | SLA 4h pilot / 60s target; clock **paused** | `PARTICIPANT_REVIEW` / `GENERATION_FAILED` (retry ×2 → ops) |
| P-05 | `PARTICIPANT_REVIEW` | Participant | result ready | 24h → `EXPIRED` (release) | `APPROVED_BY_PARTICIPANT` / back to `POSITIONED` (regen, max 3) / `REJECTED_BY_PARTICIPANT` (release) |
| P-06 | `BRAND_REVIEW` | Brand | Tier B only; Tier A → auto-approve + 5% sample flag | 24h → auto-`APPROVED` | `APPROVED` / `REJECTED_BY_BRAND` (→ `POSITIONED` once, else release) |
| P-07 | `APPROVED` | Participant | ready to post; disclosure text issued | 48h → `EXPIRED` (release) | `PUBLISHED` on URL submit / API detect |
| P-08 | `PUBLISHED` (hold) | System | URL resolves, account matches | hold: Story 24h · Reel/Post 7d · TikTok 7d; midpoint re-check for posts | `VERIFYING` / `REJECTED` (deleted/private → strike) |
| P-09 | `VERIFYING` | System (+Ops on flag) | hold ended | target 24h; flagged → ops 48h | `QUALIFIED` / `REJECTED` / `FLAGGED` |
| P-10 | `QUALIFIED` → `PAID` | System | payout computed, ledger released | wallet immediate; Swish ≤48h | terminal (`DISPUTED` window 7d) |

Terminal states: `PAID`, `REJECTED`, `EXPIRED`, `REJECTED_BY_PARTICIPANT`, `REJECTED_BY_BRAND`. All terminal non-paid states **release the reservation**.

### Verification order (P-09) — stop at first fail
1. Account matches (`SocialAccount.id` of claim)
2. Disclosure present in caption + Paid Partnership label (API) or visible in screenshot (screenshot tier) → fail = `REJECTED` reason `NO_DISCLOSURE`; fix window 12h if still live and within hold
3. Published media matches approved media (perceptual hash ≥ threshold) → fail = `REJECTED` reason `MEDIA_MISMATCH`
4. Views: API pull (API tier) or ops-entered from screenshot (screenshot tier)
5. Fraud score: velocity vs account baseline, geo mismatch, engagement ratio, account age, cross-campaign pattern → score ≥ threshold = `FLAGGED`
6. `qualified_views = views × geo_match_factor × (1 − fraud_discount)`; below campaign floor → paid at fixed component only

### Regeneration & reject signals
Every regen, move, swap, reject, and brand reject is written to `PlacementEvent` with the chosen region/product — this is the training dataset (see compliance §Training data).

---

## 2. Campaign

| State | Owner | Enters | Exits / timeout | Failure |
|---|---|---|---|---|
| `DRAFT` | Brand | builder started | submit | deleted after 30d idle |
| `SUBMITTED` | Ops | brand submits | ops review ≤2 business days | `RETURNED` with notes → `DRAFT` |
| `AWAITING_FUNDS` | Brand | ops approves; Stripe checkout or invoice issued | deposit received; 14d expiry → `DRAFT` | — |
| `FUNDED` | System | `Deposit` ledger entry | scheduled go-live | — |
| `LIVE` | System | go-live time (default Fri 18:00) | first claim → `FILLING` | 72h no claims → ops alert |
| `FILLING` | System | claims running | reserved+spent ≥ budget → `EXHAUSTED`; period end → `EXPIRED` | fill <30% at midpoint → ops alert |
| `EXHAUSTED` / `EXPIRED` | System | budget/time gone | all placements terminal (≈10d max) → `RECONCILING` | if >20% reservations release, auto-reopen `FILLING` for 24h once |
| `RECONCILING` | System+Ops | last placement terminal | report generated; refund/rollover → `CLOSED` | 7d dispute window |
| `CLOSED` | — | done | — | read-only; "run again" clones to `DRAFT` |
| `PAUSED` | Brand/Ops | brand pulls mid-flight | → `EXHAUSTED` immediately | open claims honoured and paid |

---

## 3. Participant

| State | Enters | Can | Exits |
|---|---|---|---|
| `SIGNED_UP` | auth + city + age | view previews | first account connected |
| `ONBOARDED` | ≥1 account, terms, disclosure quiz, payout details, notifications | browse marketplace, see estimates | BankID |
| `VERIFIED` | BankID ✓, 18+, no duplicate subject hash | claim | — |
| `ACTIVE` | first `APPROVED` placement | everything; reputation accrues | flag |
| `FLAGGED` | fraud ≥ threshold, strike, brand complaint | open placements continue; no new claims | ops clear → `ACTIVE` / confirm → `SUSPENDED` |
| `SUSPENDED` | 1 serious or 3 minor strikes | balance paid out; no claims 90d | auto-restore 90d / `REMOVED` on repeat |
| `REMOVED` | 2nd suspension, confirmed fraud, self-delete | nothing; BankID hash retained to block re-registration | — |

Strikes: minor = missing disclosure (fixed in window), late post; serious = deleted post in hold, media mismatch, fraud confirmed.

### SocialAccount sub-states
`CONNECTED_API` (Creator/Business + insights scope) · `CONNECTED_SCREENSHOT` (personal/private) · `BELOW_FLOOR` (<300 followers or <100 avg views; re-evaluated monthly) · `DISCONNECTED` (token revoked/expired; open placements paused up to 72h then fallback to screenshot).

---

## 4. Money

Append-only `LedgerEntry` rows. Balances are sums. Amounts in öre.

| Entry type | When | Debit | Credit |
|---|---|---|---|
| `DEPOSIT` | brand funds | client funds (external) | campaign.available |
| `RESERVE` | claim | campaign.available | campaign.reserved |
| `RELEASE_RESERVATION` | terminal non-paid | campaign.reserved | campaign.available |
| `SETTLE` | qualified | campaign.reserved | campaign.spent (actual) + campaign.available (remainder of reservation) |
| `PAYOUT_ACCRUE` | qualified | campaign.spent | participant.wallet (participant share) |
| `TAKE` | qualified | campaign.spent | nod.revenue (spread) |
| `PAYOUT_SENT` | Swish batch | participant.wallet | external |
| `REFUND` / `ROLLOVER` | close | campaign.available | external / next campaign |
| `CREDIT_TERMS_FEE` | invoice campaigns | brand invoice | nod.revenue |

Rules:
- `reservation = fixed + cpm × (2 × account.avg_views / 1000)`, capped by campaign per-placement max
- payout never exceeds reservation; over-performance reported to brand as free reach
- take rate applied per placement at settle
- wallet payout threshold 10,000 öre (100 kr); batch daily in pilot
- brand dashboard always shows `spent / reserved / available` as three derived numbers

---

## Notifications

| Event | Participant | Brand | Ops |
|---|---|---|---|
| Campaign live | push to eligible | email | — |
| Claim expiring 12h | push | — | — |
| Placement generated | push "Review your placement" | — | — |
| Brand review needed (B) | — | email + badge; reminder 18h | — |
| Approved — post now | push with disclosure text | — | — |
| Hold complete | silent | — | — |
| Qualified + paid | push + earnings card | dashboard live | — |
| Rejected | push with reason (+ fix window) | — | log |
| Fraud flag | silent | — | queue, 48h SLA |
| Fill 50/90/100% | — | email | Slack |
| Final report | — | email + PDF; dispute window opens | — |

---

## Edge cases (implement as tests)

1. Budget hits zero while claims are open → reserved claims honoured, new claims blocked, auto-reopen if >20% releases
2. Account normally 300 views gets 8,000 → `FLAGGED` on velocity; if cleared, paid at reservation cap; cap raised for next campaign
3. Disclosure missing → fail at check 2; 12h fix window if still live and in hold; re-verify once
4. Brand pauses mid-flight → `EXHAUSTED`; open claims complete and pay; remainder refunded
5. Story deleted at 6h → hold re-check fails → `REJECTED`, serious strike
6. Same image claimed twice → duplicate hash blocks at P-02
7. Token expires mid-hold → account `DISCONNECTED`, hold clock paused ≤72h, then screenshot fallback
8. Brand disputes after report → ops reviews checks 2/3 only; payouts stand unless proven; NOD absorbs cost in pilot
