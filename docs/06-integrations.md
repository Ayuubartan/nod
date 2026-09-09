# 06 — Integrations

Every integration lives behind an interface in `lib/integrations/` with (a) a real implementation, (b) a fake for tests, and (c) where marked, a **manual/ops implementation** for the pilot. Build the interface and the manual path first; wire the real provider when credentials exist.

> Provider APIs change. Before implementing each one, read the provider's current docs and put the date + doc URL in a `// VERIFIED:` comment at the top of the file. Do not implement from memory.

---

## 1. Instagram (Meta) — read-only

**Purpose:** connect account, read profile + media + insights, detect published post, pull views at hold end.

- Use **Instagram API with Instagram Login** (Business/Creator accounts authenticate directly, no Facebook Page required). Confirm current scope names for profile, media and insights read access in Meta docs; request the minimum.
- **Never request any publish/write scope.** CLAUDE.md rule 6.
- App review: needed for insights scopes before public launch; in pilot, accounts can be added as testers on the Meta app. Start the app-review submission in Milestone 1 — it takes weeks.
- Personal accounts: the API will not return insights. Onboarding step 3 prompts the Creator switch; refusal → `CONNECTED_SCREENSHOT` tier.
- Token refresh job (Inngest, daily `token-refresh`): refresh long-lived tokens; on failure → `DISCONNECTED` + reconnect prompt.
- Analytics sync (Inngest, daily `social-sync`, plus "Update now" on `/accounts` with a 1h cooldown): pull followers + 30-day view average + post count into `SocialAccountSnapshot`. Participants see deltas and a sparkline; only aggregates are stored (docs/07).
- OAuth flow: `GET /api/auth/<platform>/start?returnTo=/accounts|/onboarding` sets a 10-minute `NOD_OAUTH_STATE` cookie and redirects to the provider; `GET /api/auth/<platform>/callback` checks the state (constant-time), exchanges the code and redirects back with `?connected=<platform>` or `?error=<key>`. An account already connected to another user is refused (`accountTaken`).
- Post detection (API tier): after `APPROVED`, poll the account's recent media every 2h for a media whose caption contains the issued disclosure token or whose perceptual hash matches the approved version ≥ threshold. On match → `PUBLISHED`, store `postPlatformId`.
- View pull: at `holdEndsAt`, read insights for that media (Story: impressions/reach while still within 24h retention — schedule the pull at hold end minus 30 min; Reel/Post: plays/reach). Store `ViewSnapshot`. If the media is gone → `REJECTED` `DELETED_EARLY`.
- Paid Partnership label: read if exposed by the API for that media type; otherwise disclosure text in caption is the check.

Interface:
```ts
interface SocialProvider {
  authUrl(state): string
  exchangeCode(code): Promise<{ platformUserId, handle, accountType, isPrivate, token, refreshToken?, expiresAt }>
  profile(token): Promise<{ followers, avgViews30d, categories? }>
  recentMedia(token, since): Promise<Media[]>
  insights(token, mediaId): Promise<{ views, reach }>
  refresh(token, refreshToken?): Promise<Token>
}
```
`lib/integrations/social.ts` is the registry: `providerFor(platform)` returns the real provider when its env vars exist, otherwise the platform-specific `FakeSocialProvider` (`NOD_FAKE_PROVIDERS=1` forces the fake). Env: `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`.

Pilot fallback implementation: `ManualSocialProvider` where ops enters followers/avg views from a screenshot and view counts at hold end.

## 2. TikTok — read-only via Login Kit + Display API

**Purpose:** connect account, read profile stats + public video list, derive the 30-day view average, pull a video's public view count at hold end.

- Use **Login Kit v2** (`https://www.tiktok.com/v2/auth/authorize/`) with scopes `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`. **Never `video.publish` / `video.upload`** — CLAUDE.md rule 6; `lib/integrations/tiktok.ts` asserts this at import time.
- Tokens: access tokens last 24h, refresh tokens 365 days and **rotate on every refresh** — store both encrypted (`refreshToken` column). The pipeline calls `freshToken()` (`lib/social-sync.ts`) before any read so a stale token is refreshed on demand; the nightly `token-refresh` job covers the rest.
- Analytics: Display API has no per-video insights endpoint; `view_count` on `video.list` / `video.query` is the public count, so `profile()` averages `view_count` over videos created in the last 30 days (max 20 newest) and `insights()` returns `{ views, reach: null }`. Good enough for the floor and for view-based payout in the pilot; ops can still require a screenshot per campaign.
- Private accounts: the API returns no videos → `isPrivate` → `CONNECTED_SCREENSHOT` tier, same as Instagram personal accounts.
- App review: sandbox mode only lets the app's listed test users connect. **Submit the TikTok app for audit** (Login Kit + Display API, read scopes) before opening to the public — allow 1–2 weeks.
- Env: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` (`https://www.joinbooga.se/api/auth/tiktok/callback`). Without them the TikTok fake is served.

## 3. BankID — via broker

**Purpose:** one person = one NOD account; 18+; enables Swish payouts.

- Use a broker (Criipto, Signicat or Scrive) — one integration also covers MitID (DK), Norwegian BankID and Finnish bank IDs later. Pick on price and Nordic coverage; sandbox exists for all three.
- Trigger: first claim (not onboarding). Same-device flow on mobile, QR on desktop.
- Store **only**: `subjectHash = sha256(subject + SERVER_SALT)`, `birthYear`, `verifiedAt`, `provider`. Personnummer is never persisted. Log nothing containing it.
- Reject: age < 18 → hard stop with message; duplicate `subjectHash` → "This person already has a NOD account" + link to recover.
- Retain `subjectHash` after `REMOVED` to block re-registration.

Interface: `IdentityProvider { start(userId, returnUrl) → { url }; complete(callbackPayload) → { subject, birthYear } }`. Pilot fallback: none — BankID is required before first claim even in pilot; the broker sandbox works from day one.

## 4. Brand deposits — Stripe

- Card: Stripe Checkout, one-time payment for `campaign.budget`. Webhook `checkout.session.completed` → `LedgerEntry DEPOSIT` → `FUNDED`.
- Invoice (net-30): Stripe Invoicing; ops approves in console; `CREDIT_TERMS_FEE` entry at `creditTermsFeeBps`; campaign can go `FUNDED` on ops approval before cash arrives **only** for brands ops has whitelisted (flag). Otherwise waits for payment.
- Refunds at close: Stripe refund of `campaign.available` (card) or credit note (invoice). `ROLLOVER` if brand opts in.
- Hold deposits in a **separate bank account** from operating cash. Get the accountant's answer on client-funds handling before the first deposit.

## 5. Participant payouts — Swish

- **Pilot:** manual. Ops console exports a CSV of `wallet.available ≥ 10,000 öre` (name, Swish number, amount, memo=NOD-<batchId>), pays from Swish Företag by hand, marks each row paid → `PAYOUT_SENT` with reference.
- **Later:** Swish Payouts API (requires bank agreement + certificate). Same interface: `PayoutProvider { send(batch) → results[] }`.
- Encrypt `swishNumber` at rest; validate `+46 7x xxx xx xx`.
- Failures: retry ×3 over 24h → ops queue → participant asked to confirm number.

## 6. Placement engine

**Purpose:** given original image, region, and asset → composite where the brand looks natural.

```ts
interface PlacementEngine {
  candidates(image): Promise<Region[]>            // 2–4 surfaces with labels
  render(image, region, asset, params?): Promise<{ resultPath, engine, params }>
}
```

Implementations, in order:
1. `OpsQueueEngine` (Milestone 2): `candidates` returns a generic centre + two heuristic regions (lower third, right third); `render` enqueues to the ops generation queue; a human produces the composite in any tool and uploads it. This is the pilot.
2. `HostedInpaintEngine` (Milestone 5): hosted image-editing/inpainting API with mask + reference asset. Choose the provider at build time; keep it behind the interface.
3. `ParallelEngine` (later): the in-house engine. Same interface.

Every `render` writes a `PlacementVersion`; every participant action on it writes a `PlacementEvent`. That stream — filtered to `trainingConsent = true` and anonymised — is the training export job.

## 7. Email / push / SMS

- Resend for transactional email (templates in `emails/`, both languages).
- Web push via VAPID; store subscription on `User.pushSubscription`.
- SMS fallback (46elks or Twilio) only for: campaign drop, claim expiring, approved-post-now. Flag-gated; costs money.

## 8. Analytics & monitoring

- PostHog: funnel events named in `docs/02-product-spec.md`; identify by `User.id`, never by handle or email in properties.
- Sentry: server + client, scrub `swishNumber`, tokens, any BankID payload.
- Slack webhook for ops alerts (fill thresholds, fraud queue, payment failures).
