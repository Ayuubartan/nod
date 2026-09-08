# 13 — The waitlist game

The waitlist is the first product: a queue people want to be in, move up in, and
tell friends about. Two pages, one SMS policy, one rule — **nothing is faked**.
Every number a person sees is derived from rows in the database that a real action
wrote. No invented scarcity, no phantom referrals, no "3 people joined in the last
minute" unless three people did.

Public brand: Booga. Everything visible goes through i18n (`queue.*`,
`marketing.waitlist.*`).

## Pages

**Page one — join** (`/#waitlist`, `components/marketing/WaitlistForm.tsx`)
City (default Stockholm), mobile number (optional), email, one data-consent tick
(required) and a *separate* SMS-consent tick (optional). Button: *Ställ dig i kön*.
`?ref=CODE` and the `NOD_REF` cookie (set by `/r/CODE`) attribute the referral;
`utm_*` ride along. On success the browser goes straight to `/queue`.

**Page two — your place** (`/queue`, `components/marketing/QueueStatus.tsx`)
Rank, city, top-X%, points, level with progress bar, next goal, the invite link with
copy / SMS / WhatsApp / Snapchat / story image, the task list (email, phone,
profile, interests), this week's city leaderboard, the latest events, SMS settings
and *Leave the queue*. Identity is the `NOD_QUEUE` cookie or a signed `?t=` token
from a mail/SMS, opened by `/queue/open` (a route handler — a page cannot write
cookies), which sets the cookie (`lib/queue-session.ts`); a token that arrived by mail also proves
the address. No cookie → "email me my link".

## Rules (`lib/queue.ts`)

| Action | Points | Notes |
| --- | --- | --- |
| Email confirmed | 0 | Required to count as *verified* |
| Phone verified | +100 | 6-digit SMS code, 10 min, 5 attempts |
| Profile completed | +100 | handle + age + followers |
| Interests picked | +50 | |
| Friend verified | +250 × multiplier | Only when the friend verifies. Signing up is not enough. |
| Daily boost | +500 | Random verified people, `waitlist.dailyBoostCount` per day, 0 = off |
| Level bonus | 250 / 500 / 1000 | Social / Insider / Founding |

Rank = order by points desc, then joined-at asc, among non-deleted entries; also per
city. Percentile is `ceil(rank / total × 100)`. Position at signup is kept as a
souvenir ("you were #412"), the live rank is what matters.

Levels, by **verified** referrals: 👀 In queue 0 · ⚡ Connector 1 · 🔥 Social 3 ·
🚀 Insider 5 (priority) · 👑 Founding 10 (priority). Priority = `priorityAt` set,
which sorts first when ops grants access.

Every point is a `WaitlistPoint` row with a unique `(entryId, reason, refId)`, so a
retried job cannot double-award; `WaitlistEntry.points` is a cache of the sum.
Every state change is a `WaitlistEvent` (`SIGNED_UP, EMAIL_VERIFIED, PHONE_VERIFIED,
PROFILE_COMPLETED, FRIEND_JOINED, FRIEND_VERIFIED, RANK_CHANGED, LEVEL_UNLOCKED,
REWARD_UNLOCKED, ACCESS_GRANTED, ACCESS_USED`); the digest reads unnotified ones.

### Referral counting

A referral counts when the referred person verifies (email link or phone code) and
none of these hold: same email as the referrer, same phone, same IP hash, or the
referrer already has `MAX_REFERRALS_PER_IP` (5) verified referrals from that IP hash.
Non-counting referrals are still recorded (`FRIEND_VERIFIED` with `counted: false`)
so the person sees "did not count" rather than nothing. IPs are stored only as an
HMAC hash. `/ops/waitlist` lists hashes with ≥3 referred signups for a human look.

## SMS (`lib/waitlist-sms.ts`)

- Only with separate consent (`smsConsentAt`, no `smsOptOutAt`) and a verified phone.
- Only for meaningful events: friend verified, level unlocked, reward, *your turn*.
- Aggregated: one digest per person, at most every 6 hours, never 22:00–08:00
  Stockholm. `inngest/waitlist.ts` ticks every 15 minutes.
- Verification codes and the access message ("DIN TUR! … gäller i 48h") are sent
  immediately; they are what the person asked for.
- STOP / STOPP / SLUTA / AVSLUTA on the inbound webhook (`/api/webhooks/sms?key=…`)
  sets `smsOptOutAt`. The switch on `/queue` does the same.
- The whole channel is behind `waitlist.smsEnabled`; off in a fresh deploy.

## Access

`waitlist.gate` on: nobody without `accessGrantedAt` (unexpired) may open an
account — `resolveIdentity` returns `waitlistOnly` with a link back to `/queue`.
Ops grants access to the next N from `/ops/waitlist` (verified → priority → points →
joined-at), which sets a 48h window, writes `ACCESS_GRANTED`, texts + mails, and
audits. Onboarding calls `markConverted` → `ACCESS_USED`. An expired window simply
stops opening the door; ops grants again. `waitlist.gate` off: everyone verified can
open an account, the queue is a warm-up.

## Abuse

Rate limits on join (5/min/IP), phone codes (3/15 min/number), verify attempts,
link requests. Self-referral checks above. Duplicate email → the existing person is
mailed their link, nothing is created. Duplicate phone → refused.

## GDPR

Three consents, stored separately with timestamps: necessary processing (join),
SMS (`smsConsentAt`), marketing (`marketingConsentAt`, not asked yet). Opt-out and
*Leave the queue* (soft delete, drops out of every count; points it earned for
others remain because they were real). `legal/privacy.*.md` has the bullet and the
purposes rows. Minimum data: no personnummer, no raw IP.

**Have Swedish/EU counsel review the flows before scaling** — in particular the SMS
consent wording, the leaderboard (display name is opt-in), and the IP hash under
legitimate interest.

## Ops

`/ops/waitlist`: totals, level distribution, top 20, suspicious networks, the four
flags (`gate`, `smsEnabled`, `boostMultiplier`, `dailyBoostCount`), grant access.
`/ops/signups` keeps the raw list.

## Not built (deliberately)

- No SMS-only signup; email is the identity. Phone is a task, not a requirement.
- No purchase of positions, no paid boosts.
- No automatic "you dropped a place" texts — rank loss is shown on the page, not
  pushed.
