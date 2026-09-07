# 02 — Product Spec

Three surfaces in one Next.js app, separated by route group and role. Responsive web / PWA first — no native app for the pilot. Push via web push (fallback SMS via Twilio/46elks if needed).

---

## A. Participant app — `app/(participant)/`

### A1. Onboarding (9 screens, target < 5 min median)

| # | Screen | Behaviour | Exit state |
|---|---|---|---|
| 1 | Sign up | Phone (OTP) or Apple/Google via Supabase Auth. Country fixed SE for pilot. City select. Age bracket (no <18 option). | `SIGNED_UP` |
| 2 | Connect Instagram | "Instagram API with Instagram Login" OAuth. Request read-only scopes for profile, media, insights. Show exactly what NOD reads and never does (post/edit/message). | `SocialAccount` created |
| 3 | Creator switch | If account type is personal: 20-second illustrated guide to switch to Creator. Frame: *unlocks verified views = higher payouts*. Buttons: "Done, reconnect" / "Skip for now" (→ screenshot tier). | tier set |
| 4 | Profile preview | Show pulled data: followers, avg views last 30 days, detected category (user confirms/edits). Show **estimated earnings per campaign**. | — |
| 5 | Terms + disclosure check | Accept terms. Then one question: "Which of these is correct disclosure?" 3 options, one correct. Must pass. Record `disclosure_quiz_passed_at`. | — |
| 6 | Training-data consent | Separate checkbox (not bundled): allow anonymised placement choices and images to improve the placement engine. Default unchecked. Can change in settings. | `training_consent` |
| 7 | Payout details | Swish number (validate SE mobile format). | — |
| 8 | Notifications | Web push permission; fallback SMS opt-in. Explain: "Campaigns drop Fridays 18:00." | — |
| 9 | Done | "You're in. Next drop: [date]." Referral link + share. | `ONBOARDED` |

BankID is **not** in onboarding. It gates the first claim (see A3).

> **As built (2026-09-07):** screens 6–8 are no longer in the flow. A new creator has
> nothing to pay out, train on or be notified about yet, so the flow is 1–5 and done —
> four screens for a Creator account. Swish is asked for in the wallet (highlighted as
> soon as money is pending) and in settings; training consent lives in settings, default
> off; the done screen offers the notification permission. `completeOnboarding` still
> accepts the old fields.

Track drop-off per screen in PostHog. Targets: ≥60% complete 1→9, ≥70% accept Creator switch.

### A2. Marketplace — `/campaigns`
- Tabs: For You · Highest paying · New · Ending soon · by category
- Campaign card: brand logo, name, category chips, **"Du får ~X kr"** computed for *this user's* best eligible account, remaining budget bar, ends-in, eligibility badge (Eligible / Not eligible: reason)
- Campaign detail: brand, products (assets), eligible content types, placement rules (plain language), disclosure text they'll need to use, payout structure, remaining budget, period, "Claim with [account picker]"
- Locked state if not verified: "Verify with BankID to unlock campaigns"
- Empty state before first drop: countdown to next Friday 18:00

### A3. Claim → Placement flow (steps P-01 → P-07 from workflows)
- **BankID gate** (Criipto): first claim only. On success set `VERIFIED`, store hash + birth year, reject if <18 or duplicate subject.
- **Claim**: pick account → system checks eligibility, cap, budget → reserves → 48h timer shown
- **Upload**: image/video; client-side compression; pre-check result shown inline
- **Position**: engine returns 2–4 candidate regions with a product each; user picks one, or draws a rectangle. Product selector if campaign has several.
- **Generating**: progress state; in pilot may say "Ready within 4 hours — we'll notify you"
- **Review**: before/after slider. Buttons: Approve · Regenerate (counter shows 3 left) · Move · Swap product · Reject. 24h timer.
- **Brand review** (Tier B only): "Brand is reviewing — usually < 24h"
- **Ready to post**: download media; disclosure text with copy button; checklist: ☐ disclosure in caption ☐ Paid partnership label ☐ posted to [account]; then "Submit post URL" (API-tier: "We'll detect it automatically — or paste URL"). 48h timer.
- **Hold**: "Live. Verifying on [date/time]." Don't delete before then.
- **Result**: Qualified → earnings card (shareable image: "+88 kr · NOD"). Rejected → reason + fix window if applicable.

### A4. My placements — `/placements`
List with state chips and timers. Filters: active / paid / rejected.

### A5. Wallet — `/wallet`
Balance (pending / available / paid out). Transaction list per placement. "Payout" info: automatic when ≥100 kr, within 48h. Earnings card gallery for re-sharing.

### A6. Accounts — `/accounts`
List of connected accounts with tier, eligibility floor status, reconnect prompt when token expired. Add account.

### A7. Settings
Language, notifications, training-data consent toggle, download my data, delete account (triggers erasure job with 30-day grace).

### A8. Referrals — `/invite`
Link, code, count of invited → verified → first placement. Bonus rules from pricing doc.

---

## B. Brand dashboard — `app/(brand)/`

Auth: email magic link (Supabase). `BrandUser` roles: admin, member. One `Brand` per org; ops creates the Brand and invites the first admin in pilot.

### B1. Campaign builder — `/campaigns/new` (6 steps, saves draft each step)
1. **Basics**: name, objective (awareness only in pilot), period, go-live (default next Friday 18:00)
2. **Audience**: country (SE), cities (multi), age brackets, follower range, content categories, exclusions (categories/keywords)
3. **Assets**: upload products/logos (PNG with alpha preferred), name each, mark allowed placement types (product / logo / packaging / signage)
4. **Rules**: plain-language placement rules (max 5 bullets), brand-safety exclusions, review tier (A auto+sample / B every placement — Tier B mandatory on first campaign), disclosure text (prefilled from template, editable within compliance guard)
5. **Payout template**: pick Fixed / CPM / Hybrid / Hybrid+bonus; set numbers; floors enforced; live preview: "At this price, expected fill ~X% in Y days" (pilot: simple heuristic based on eligible-account count and avg views)
6. **Budget & funding**: total SEK; per-person cap (default 2 placements); pay by card (Stripe) or request invoice (adds credit-terms fee %, ops approval). Submit → `SUBMITTED`.

### B2. Campaign dashboard — `/campaigns/[id]`
- Header: state, period, budget: **spent / reserved / available** (three numbers)
- KPIs: participants, placements (by state), total views, **qualified views**, est. unique reach, avg frequency, **effective CPM**
- Charts: daily qualified views; fill progress
- Placements table: thumbnail, account handle, city, views, qualified views, state, disclosure ✓, link to post. Filter/sort. Tier B: review queue tab with Approve/Reject + reason.
- Breakdown tabs: city · category · placement type · (demographics if available from API)
- Report: at `RECONCILING`, generate PDF summary; 7-day dispute button per placement.

### B3. Brand settings
Org details, users, billing history, invoices, refund/roll-over preference.

---

## C. Ops console — `app/(ops)/` (role `ops`)

Internal, plain, fast. Tables over charts.

- **Campaign review**: submitted campaigns → approve / return with notes; funding status; force state transitions with mandatory reason (audited)
- **Generation queue** (pilot): claims in `GENERATING` → download original + region + asset → upload result → marks `PARTICIPANT_REVIEW`. This is the manual engine implementation.
- **Verification queue**: placements at hold end → auto-checks result shown; screenshot-tier: enter views manually from screenshot; fraud flags with score breakdown → clear / reject / suspend
- **Payout batch**: list of available balances ≥100 kr → export Swish CSV → mark paid (pilot). Later: Swish API.
- **Participants**: search, state, strikes, accounts, tier, flag/suspend/restore with reason
- **Brands**: create org, invite user, view campaigns
- **Flags**: feature flags (review tier defaults, floors, referral bonus on/off, drop schedule)
- **Audit log** viewer

---

## Cross-cutting

- **Notifications matrix**: implement exactly the table in `docs/03-workflows.md` §Notifications.
- **Timers**: every screen showing a timed state shows the deadline in local time and relative ("expires in 11h").
- **Empty states** written in both languages; never a blank table.
- **Accessibility**: WCAG AA, keyboard-navigable, alt text on all placement images.
- **Performance**: participant app must be usable on a 3-year-old Android over 4G. Images served resized via Supabase transforms.
