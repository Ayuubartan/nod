# Work log

Running notes on what changed after the milestone plan in `docs/09` was completed, why, and
what it unlocked. Newest entry first. Each entry names the commit it describes.

---

## 2026-09-10 (later) — Social sign-in, done directly instead of through Supabase

**Ask:** make the logins actually work, and get the profile back from Google and
Facebook.

**This supersedes the entry below it, which shipped the same morning in `ab9cd78`.** That
version brokered Google and Apple through Supabase Auth. It was not wrong, but it was
carrying a whole service for one feature: **this project's database is Neon**, so
Supabase would have existed on the account solely to pass an email address along — and
with it a second redirect hop and a second exact-match allowlist to get wrong. The entry
stays as written; a decision that lasted eight hours is still worth being able to read.

### Direct OAuth — `lib/signin-providers.ts`

Two adapters behind one small interface (`authUrl`, `exchange`, `configured`), the same
shape `lib/integrations/social.ts` already uses for Instagram and TikTok:

- **Google** — `openid email profile`, `access_type=online` (NOD has no reason to act
  for someone while they are away, so it never asks for a refresh token) and
  `prompt=select_account`, because someone with several Google accounts needs to pick
  and silent reuse of the last one is a support ticket. The profile is read from the
  userinfo endpoint rather than by decoding the `id_token`: the token came from Google's
  own token endpoint over TLS in a request we made, so a signature check adds a JWT
  dependency and a key-rotation concern without adding a fact.
- **Facebook** — `public_profile,email` on the **same Meta app as the Instagram
  connection**. It is a second product on that app, not a second app, so
  `META_APP_ID`/`META_APP_SECRET` are reused and Google is the only provider that adds
  new credentials. Facebook omits the address entirely when it has not confirmed one, so
  a returned address *is* a verified one — and an absent one falls through to
  `socialNoEmail`, which says "use an email code instead" instead of failing obscurely.

**Apple is dropped from this phase**, on purpose: a paid developer account and a client
secret that is an ES256 JWT to be regenerated every six months. It is a third adapter
whenever that is worth doing.

### What stayed, and one thing that got stricter

The shell from the morning is unchanged and was the right shell: state cookie,
`resolveIdentity`, NOD's own session cookie, the `?error=` allowlist, the form, the i18n.
Only the middle — "get a verified address from a provider" — was swapped.

One rule got stricter. The Supabase version tolerated a missing `state` on the callback,
because its PKCE flow does not round-trip ours. Direct OAuth always does, so a missing
`state` is now a defect rather than a variant. The cookie also carries **which** provider
started the flow, and a callback under a different provider's path is refused — a code
issued by one provider can never be presented as the other.

`enabledSocialProviders()` now requires the provider to be **listed and credentialled**.
Either condition alone yields a dead button, and the list is what stops `META_APP_ID` —
set for the Instagram connection, quite possibly months earlier — from silently putting a
"Continue with Facebook" button on the page before Facebook Login exists on that app.
`NOD_FAKE_PROVIDERS` is deliberately never consulted here: it simulates *connecting an
account*, and a simulated way to become any user is not something sign-in should own.

One honest caveat to "no Supabase project is involved": `lib/auth.ts` and `middleware.ts`
still construct a Supabase client and fall back to a Supabase session. Nothing issues one
any more, and `supabaseServer()` throws when unconfigured — which `currentAuthId` catches
— so it costs nothing and breaks nothing. Removing it is a separate cleanup, not part of
this change.

### The profile — `User.name`

`name` is the only field added, and only because a provider hands it over; there is no
form for it anywhere and onboarding still asks only for city and age. No avatar: nothing
in the product displays one, and storing a picture URL with no consumer is exactly what
CLAUDE.md rule 7 forbids.

It rides in the session cookie as an optional field, because a first-time social sign-in
has no `User` row yet — onboarding creates that row and takes the name from the session.
Older cookies have no `name` and still decode. Its consumer is ops: searchable next to
handle and email, and shown on the participants list, which is what support actually
needs when someone writes in under a name rather than a handle.

`docs/07`'s minimisation table carries the field, and the GDPR erasure job clears it
alongside `email` and `city`.

### Tests and verification

30 tests across `tests/social-signin.test.ts` (24) and the two added to
`tests/session.test.ts`: the both-conditions env matrix, each adapter's authorize URL and
its parsing of a mocked exchange, the Facebook no-email path, `parseState` against
tampered and provider-less cookies, and the `?error=` allowlist.

**The OAuth round-trip is not verified and cannot be from here** — it needs OAuth clients
registered at Google and Meta, which only the account owner can create. What is verified
is typecheck, lint, `next build`, the non-database suite, and the authorize URLs the
adapters construct. The migration is one nullable column with no backfill.

---

## 2026-09-10 — Social sign-in (Google, Apple)

**Ask:** wire the social sign-in that `docs/08` has named since day one and this log has
carried under "Still open" ever since — the email code was the only live method.

### Sign-in with a provider — `lib/social-signin.ts`, `app/api/sign-in/`

The temptation was a second identity system beside the code flow. It is not one. Supabase
proves an address; from there the path is **`resolveIdentity`**, the same function
`verifyCode` calls, so the waitlist gate, the `OPS_EMAIL` rule, the brand allowlist and
the onboarding hand-off cannot drift between the two ways in. What comes out is NOD's own
signed cookie (`lib/session.ts`), and the Supabase session is ended (`scope: 'local'`) in
the same breath — one person with two live sessions is a signing-out bug waiting to
happen, and `signOutEverywhere` should only have one thing to end.

**Linking is by verified address.** Sign up with a code today, press "Continue with
Google" tomorrow, and it is the same `User` row, because `resolveIdentity` looks the
address up before it mints anything. That is only safe because of the check next to it:
an address is trusted only when Supabase confirmed it or the provider claims
`email_verified`. Without that, a provider that lets an account assert an unverified
address is a way into someone else's account — the linking rule and the verification
rule are one decision, not two.

- Routes are `/api/sign-in/{provider}/start` and `/api/sign-in/callback`, deliberately
  **not** under `/api/auth/*`. That prefix is `lib/social-oauth.ts`, which attaches a
  TikTok or Instagram account to a session that already exists. This one creates the
  session. Same word, opposite direction; separate paths so nobody wires them together
  by accident.
- The state cookie carries the nonce, the audience and the destination, so the callback
  trusts nothing the query string alone asserts. Supabase's PKCE flow does not round-trip
  our `state`, so the cookie is the proof this browser started the sign-in; when a state
  *is* returned it still has to match.
- `?error=` reaches the form as a translation key, and the address bar can put anything
  there. `signInErrorFrom` allowlists the thirteen codes this app actually produces —
  an unknown key would otherwise render as itself.
- The buttons are `<a href>` to a route handler. No client SDK, no token anywhere near
  the browser, and the waitlist's embedded variant does not get them: the address is
  already known there and a provider button would drop the person out of a queue flow
  they are halfway through.

### What decides whether a button appears

`NOD_SOCIAL_PROVIDERS` is an explicit list, not "Supabase is configured, so show both".
Providers are enabled one at a time in the Supabase dashboard and Apple needs a paid
developer account; a button that leads to a provider error is worse than no button.

**This is off in production and the reason is not a missing list.** joinbooga.se runs on
Neon, so `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` do not exist
there at all (`vercel env ls production`, 2026-09-10). The four steps to turn it on are
in `docs/12`, in order, including the one that fails silently if skipped: the callback
URL must be on Supabase's Redirect URLs allowlist.

**Apple's Hide My Email** hands back a `@privaterelay.appleid.com` address. It will not
match an existing code-flow account, so it opens a second one. Recorded here so it is a
known property and not a support mystery.

### Tests

16 unit tests in `tests/social-signin.test.ts` over the surface that decides whether a
button appears, whether a callback is trusted and whether an address may be linked:
the `enabledSocialProviders` env matrix (including both half-configured states),
`emailIsVerified`, `parseState` against truncated and non-object cookies, and
`signInErrorFrom` against injected values. The OAuth round-trip itself needs a Supabase
project and a browser and is **not** asserted — what is verified locally is typecheck,
lint, the full suite and `next build`.

---

## 2026-09-07 — Direct placement, creative as a distribution layer, brand dashboard

**Ask:** make the AI placement happen directly for everyone (no waiting on the ops queue),
make NOD work as a distribution layer where the brand can change the creative on a live
campaign, and make the brand dashboard actually useful.

### 1. Direct placement — `LocalCompositeEngine`

The pilot had a gap: docs/06 §6 lists three engines (ops queue, hosted inpaint, in-house),
and with no inpainting key configured *every* placement waited for a human. That made the
product a service, not a marketplace.

`lib/integrations/composite.ts` closes the gap with an in-process compositor (sharp): it
scales the product to the surface the participant chose, sits it on the bottom edge of that
surface, matches its brightness to the scene under it, and drops a soft shadow. ~200 ms,
no third party, no cost per render. Nothing outside the chosen region is touched, which is
also what the media-match verification check relies on.

The engine chain is now, top to bottom:

```
hosted inpaint (if INPAINT_PROVIDER + INPAINT_API_KEY)
  -> local composite (always available)
    -> ops queue (a human; never fails)
```

Each layer is wrapped in `FallbackEngine`, so an outage degrades one step instead of
stranding the participant in GENERATING. `NOD_ENGINE=hosted|local|ops|fake` forces one
layer; the DB flag `engine.autoRender` (default on) is the ops kill switch — off means
every render waits for a human, exactly as in the pilot, without a deploy.

`lib/render.ts` is the one place P-04 happens. Before it, the position step and the
regenerate step each did half of the work differently, and a regeneration never actually
asked the engine for anything. Now: position → `generate()` → PARTICIPANT_REVIEW on the
same request. Regenerate, brand swap, the Inngest retry job and the ops "Run engine"
button all call the same function.

The position step itself (`components/participant/PositionStep.tsx`) now shows the
participant's real photo with the product previewed inside a draggable region, so they
see where the product will land before they confirm — instead of picking from three
labelled rectangles on a grey box.

### 2. Creative as a distribution layer — `lib/creative.ts`

A brand uploads a product once and NOD distributes it into many people's posts. The
consequence: the creative is not frozen at launch. `replaceCreative()` retires an asset,
points every *swappable* placement at the replacement, and re-renders them. Swappable
means nobody has approved an image yet: `POSITIONED`, `GENERATING`, `GENERATION_FAILED`,
`PARTICIPANT_REVIEW`. From `BRAND_REVIEW` onward the image is locked — the participant
said yes to *that* picture and will publish it to their own account.

Design decisions:

- The participant's region is kept (it is their training label).
- The swap does not consume any of the participant's three regenerations —
  `regenerate()` grew `kind: 'REGEN' | 'MOVE' | 'SWAP'` and `countsTowardLimit` for this.
- The retire is audited (`CampaignAsset RETIRE`, with the affected placement ids) and the
  swap lands on the training stream as a `SWAP` PlacementEvent, so the export can tell
  brand-driven changes from participant taste.
- The last asset on a campaign cannot be retired.

The brand sees it on the campaign's **Creative** tab: per asset, a thumbnail, how many
placements are still in flight on it, "Replace with… → Replace and re-render", and Retire
(disabled while anything is in flight).

### 3. Brand dashboard

Rebuilt around what a brand actually asks: *how full is it, where are people stuck, is
anything waiting on me.*

- **Campaign index** — summary strip (active campaigns, total budget, placements,
  qualified views), then one card per campaign with a fill bar (spent solid, reserved
  hatched), a "next step" hint keyed on the campaign state, and a review-queue badge.
- **Campaign overview** — shared `CampaignHeader` (back link, state chip, next step, dates,
  fund button when awaiting funds) and `CampaignTabs` (Overview · Creative · Review ·
  Report · Edit). Then: budget trio + fill bar, KPIs, a nine-stage placement **funnel**
  (claimed → making → participant review → brand review → approved → published →
  verified → paid → ended; the brand-review stage links to the queue), a creative strip
  with in-flight counts, the daily views chart, and a placement table with the rendered
  thumbnail, handle, city, content type, views, qualified views, disclosure and post link.
- All new copy is in `brandApp.*` in `en.json` / `sv.json`.

### 4. Seed and dev ergonomics

- The seed generates real artwork (`lib/demo-art.ts`: coffee bag in autumn and winter
  palettes, a logo, a kitchen scene and a desk scene — shapes only, so it renders the
  same on every machine) and writes it to `.storage/` at the paths the media proxy
  serves. It then drives four placements on the live campaign through the real state
  machine: one in participant review, one in brand review, one published, one paid.
- `pnpm db:seed` runs with `--conditions=react-server` so the `server-only` guard on
  `lib/render` and `lib/storage` is a no-op outside Next.
- `emit()` returns immediately when there is no `INNGEST_EVENT_KEY` (and no
  `INNGEST_DEV=1`). Before this every emit was a 2 s 401 against the cloud API; the seed
  took 79 s, now 3 s, and every server action in dev was paying the same tax.
- `NOD_FAKE_PROVIDERS` no longer forces the fake engine — the compositor has no third
  party behind it, so dev gets real renders. Tests set `NOD_ENGINE=fake` themselves.
- `lib/flags.ts`: flag values are widened from their literal defaults (a flag whose
  default is `false` can be set to `true` without a cast).

### Tests

- `tests/composite.test.ts` — output keeps the canvas size, the product lands inside the
  region, pixels far from the region are unchanged within JPEG noise, bad input throws.
- `tests/creative.db.test.ts` — position renders straight to PARTICIPANT_REVIEW with a
  version; `engine.autoRender=false` defers and "run engine" later renders; missing asset
  fails cleanly; swap re-renders in-flight placements, leaves BRAND_REVIEW alone, does not
  touch `regenCount`, retires softly, audits, and refuses same-asset / cross-campaign.

`pnpm typecheck && pnpm lint && pnpm test` — 279 tests green.

### Follow-ups found in the browser walkthrough

- A brand session landing on a participant route (`/placements`) redirected to
  `/campaigns`, which is also a participant route: an infinite 307 loop. `requireRole`
  now sends brand sessions to `/brand/campaigns`.
- Retired assets leaked into two places that read `campaign.assets` without a
  `deletedAt` filter: the participant's campaign page (the product chips) and the
  campaign submit guard (a campaign whose only asset was retired could still be
  submitted). Both now filter. The ops generation queue deliberately keeps all assets —
  a placement that got stuck may reference one that has since been retired.
- `StateChip` gained a `perspective` prop. The brand's placement table showed
  "Väntar på dig" on PARTICIPANT_REVIEW, which is the participant's wording. From the
  brand side the participant's steps are neutral "in progress" (`Deltagaren granskar`)
  and BRAND_REVIEW is the amber "waiting on you". Keys live under
  `placement.brandStates` (sv/en) and only cover the states whose wording depends on
  who is reading.

### Walkthrough (what the screenshots show)

1. `/dev` → sign in as Anna (`seed-p1`) → open the placement in participant review — the
   composite the seed rendered, with before/after and the regenerate controls.
2. As Jonas: claim on the live campaign → upload `.storage/demo/kitchen.jpg` → the
   position step shows the photo with the (winter) bag previewed inside a draggable region
   and three dashed suggestions → tap the counter suggestion → Fortsätt → the composite
   (brightness-matched, soft shadow, sitting on the plate) is in review on the same
   request, with the before/after slider and "Generera om · 3 kvar".
3. `/dev` → brand user → `/brand/campaigns` (index) → the live campaign (overview with
   funnel and fill) → **Creative** tab → replace "Kaffepåse 500g" with "Kaffepåse — vinter"
   → in-flight placements re-render in the winter palette.
4. `/dev` → ops → generation queue — empty unless `engine.autoRender` is off.

### 5. Intro video — `scripts/intro-video/`

An explainer/ad for NOD, rendered from code so it stays in sync with the product's
palette and copy: `docs/media/nod-intro.mp4`, 1920×1080, 30 fps, 78.6 s, narrated.

- `render.mjs` describes eight scenes as functions of time that return SVG (logo →
  problem → idea → participant flow → getting paid → brand dashboard with a creative
  swap → trust rules → call to action). sharp rasterises each frame, ffmpeg encodes
  them from stdin, then a second pass mixes the narration and a synthesised pad.
- The flow and brand scenes use real renders from the seed: Anna's kitchen photo with
  the autumn and winter bags, and the shelf/sill composites from the creative swap, so
  the "re-render" moment in the video is the actual output of `LocalCompositeEngine`.
- `narration.json` + `tts.ps1` produce the voice with the Windows speech synthesizer
  (Zira). It is a placeholder read; drop recorded WAVs with the same ids into
  `.build/vo/` and re-run `pnpm video`. Missing WAVs fall back to music only.
- `--frame <t> --png <file>` dumps a single frame, which is how the layout was checked
  (contact sheets of eight frames per half).

### 6. Sign-in — `lib/login.ts`, `lib/session.ts`, `app/(auth)/`

Until now there was no way in. The brand sign-in page was a static placeholder,
onboarding minted a fake `dev-…` auth id, and nothing signed anyone out. Creators and
brands now log in with an emailed six-digit code and get different surfaces:

- `/sign-in` (creators) and `/brand/sign-in` (brand users) share `LoginForm`. The
  audience decides the copy and what an unknown address means: a new creator gets an
  auth id and goes to onboarding; an unknown brand address is refused, since brand
  accounts are created by ops (docs/09 "not in scope": no self-serve brand signup).
- `LoginCode` stores an HMAC of the code (keyed by `ENCRYPTION_KEY`), ten-minute
  expiry, five attempts, superseded by a new request, consumed on success. Request and
  verify are rate limited per address.
- A verified code becomes `NOD_SESSION`, a signed cookie of NOD's own
  (`lib/session.ts`). `currentAuthId()` reads it between the dev persona cookie and the
  Supabase session, so nothing else in the app changed. `ops@nod.se` uses the creator
  page and is routed to `/ops` by role.
- Sign-out everywhere (own cookie, dev cookie, Supabase) from the brand header, ops
  header and the participant settings page.
- Without `RESEND_API_KEY` the code is shown on the page (dev only). `/dev` stays as
  the one-click shortcut.

Found while testing: `/brand/campaigns` and `/brand/settings` rendered for anonymous
visitors. They used an optional `getSession()` and treated "no session" like "ops", so
every brand's campaigns were listed to anyone who knew the URL. Both now go through
`requireBrandScope()`, which redirects to the sign-in. Verified with curl that every
app route bounces an anonymous request (`/brand/*`, `/campaigns`, `/placements`,
`/wallet`, `/onboarding`, `/ops/*`).

Tests: `tests/session.test.ts` (tamper, expiry, junk) and `tests/login.db.test.ts`
(hashing, rate limit, supersede, existing/new creator, brand ok/refused, brand address
never becomes a creator identity, attempt burn, replay, expiry, open-redirect guard).

### 11. The waitlist game — `docs/13-waitlist.md`

The waitlist was a form and a thank-you. Now it is the first product: join with city,
mobile and email, land on `/queue` with a rank, a level and an invite link, and move
up by doing real things — confirm email, verify phone, fill in the profile, and above
all get friends to join *and verify*. Points are a ledger (`WaitlistPoint`, unique
per reason and reference, so nothing double-awards), state changes are events
(`WaitlistEvent`), and rank is computed from the ledger on every page load. Nothing
is faked: no invented scarcity, no phantom referrals, no positions that are not the
sum of rows.

Referrals count only on verification and never for the same email, phone or IP
hash; the person still sees "a friend confirmed — did not count". SMS exists but is
polite: separate consent, one digest per six hours at most, silent 22–08, STOP on
the inbound webhook, and the whole channel behind `waitlist.smsEnabled`. Access is
a gate flag: while it is up, only people ops let through (`/ops/waitlist`, 48h
window, audited) can open an account; sign-in says so and points back to the queue.

Old fields (handle, age, followers, categories) moved from the join form to
`/queue` where they earn points; the columns are nullable now, and onboarding
prefill copes. `/r/CODE` sets a referral cookie and lands on the form. Privacy policy
has the queue bullet and two purpose rows. Counsel should read docs/13 before the
numbers get big.

Tests: `tests/queue.test.ts` (levels, phone normalisation, percentile, referral
rules, digest text, week start) and `tests/queue.db.test.ts` (join → rank,
duplicate → link, referral credit on verify + level + priority, self/same-IP not
counted, idempotent points, profile points, grant order + expiry, digest with the
fake SMS provider, STOP, the sign-in gate).

### 10. After joining

What happened after someone joined was two dead ends. The waitlist ended in "we'll be
in touch" with no way into the product; a creator who found /sign-in instead typed
the same city, age and handle again under a fresh identity; and the first thing
either saw after onboarding was an empty campaign list behind a "verify with BankID
to unlock" banner — a wall in front of nothing.

Now: the waitlist success screen has one primary action, *Open your account*, which
requests the sign-in code for the address they just used and shows the code field in
place (`LoginForm` in embedded mode). The confirmation mail says the same and links
to sign-in. Onboarding reads the waitlist entry for the session's address and uses
its answers as defaults; a waitlist referral becomes an account referral when the
referrer has an account (`prefillFromWaitlist`, tested). `/campaigns` is the home
screen: while the creator cannot claim yet, or there is nothing to claim, the top of
the page is a countdown to Friday's drop and a four-row checklist — connect account,
BankID, notifications (asks permission in place), invite — with their per-post
estimate. Done rows stay as receipts; when everything is done the block says so.
The queue position keeps its meaning: who is told first when a drop opens.

Not changed: brand sign-in stays invite-only (ops creates brand users from an
enquiry), and the email-code login itself. A magic link would save typing six
digits; not worth a token flow yet.

### 9. Boogaa

The public name is Boogaa, on joinbooga.se. `lib/brand.ts` holds the constants; i18n,
legal texts, emails, OG images, the PDF report, SMS sender, manifest and every layout
wordmark use them. NOD remains the codename everywhere users cannot see (repo, docs,
`NOD_*` env vars, `NOD_SESSION` cookie) — renaming those would log everyone out for
no gain. Domain is added to the Vercel project (apex redirects to www); DNS records and
Resend verification for the new domain are the remaining steps.

### 8. Shorter creator onboarding

Nine screens became five plus "done". Swish, training consent and the notification
prompt were moved out of onboarding to the places they first matter (wallet + settings,
settings, done screen) — `completeOnboarding` takes only terms + quiz now, with the old
fields optional. The wallet shows a Swish card whenever no number is on file and turns
it amber the moment money is pending, since `payableWallets` silently skips wallets
without one. `SwishForm` is shared between wallet and settings. docs/02 A1 carries an
"as built" note.

### 7. Live on Vercel — `docs/12-deploy.md`, `lib/storage.ts`

The demo runs at nod-ayuubartans-projects.vercel.app: Vercel (arn1) + Neon Postgres from
the Marketplace, migrations in the build command, production database seeded.

- Neon has no file storage, so `lib/storage.ts` gained a third backend, **Vercel Blob**,
  chosen when `BLOB_READ_WRITE_TOKEN` exists and the Supabase keys do not. Reads still
  go through `/api/media`, so the access rules there hold for every backend. The CLI
  can only create public stores, hence `BLOB_ACCESS=public` for the demo and a
  DECISION comment on why that is not the pilot setup.
- The seed now writes media through `lib/storage` (a seed against a hosted database
  puts the images where that deploy reads them), and `pnpm storage:push` copies an
  existing `.storage/` into the configured store for databases seeded earlier.
- Swedish copy said "brand"/"brands" throughout — an anglicism the Swedish pages should
  not carry. Now varumärke/varumärken/varumärket/varumärkeskonto everywhere in
  `sv.json`, the privacy policy and docs/01. The `/brands` and sign-in pages had
  hardcoded English titles; they use `generateMetadata` with translations like the
  legal pages.
- Waitlist entries and brand enquiries were stored but visible nowhere in the console.
  `/ops/signups` lists them with account creations, newest first, and the ops home
  shows the last seven days of each — the numbers that matter before launch.

### Still open

- ~~Social sign-in (Google/Apple via Supabase) is still unwired~~ — done 2026-09-10, see
  the entry at the top of this file. Off in production until the Supabase Auth variables
  exist there (docs/12).
- The live demo's seeded placement images live in a local `.storage/`; they show once
  `pnpm storage:push` has run with the Blob token (docs/12). New uploads on the live
  site go straight to the store.
- The compositor is a compositor: it does not relight, occlude or match perspective. The
  hosted inpaint engine (M5 task 1) sits above it for that and activates on credentials.
- Swaps re-render synchronously in the brand's request. Fine at pilot scale (tens of
  placements); at hundreds it should fan out to an Inngest job per placement.
- Retired assets stay visible as "retired" in the manager; there is no un-retire yet.
- The video's narration is synthetic. A human read (Swedish, ideally) is the obvious
  upgrade; the timeline gives each scene ~1 s of slack after its line.
