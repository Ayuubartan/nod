# 12 — Deploying NOD (Vercel + Supabase + Resend)

The stack in docs/08 was chosen so that a deploy is configuration, not code. This is
the runbook. Everything here was verified against `pnpm build` on 2026-09-07; the app
runs with fakes for every provider you leave unset (BankID, Instagram, Stripe, Swish,
SMS), so the first deploy needs exactly three things: a database, mail, and two secrets.

## What Vercel needs from the repo

Already in place:

- `vercel.json` — region `arn1` (Stockholm, so data stays in the EU next to the
  Supabase project), and a build command that runs `prisma migrate deploy` before
  `next build`. Migrations therefore ship with the deploy that needs them; a failed
  migration fails the build, never the running site.
- `next.config.ts` traces `legal/*.md` into the serverless functions, because the
  legal pages read them from disk at request time.
- `/dev` returns 404 in production and the dev persona cookie is ignored there.
- The sign-in code is only shown on the page outside production; with `RESEND_API_KEY`
  set it is mailed.
- `ENCRYPTION_KEY` and `BANKID_SUBJECT_SALT` are refused when missing in production.

## 1. Database and storage — Supabase

Create a project at supabase.com, **region EU (Stockholm or Frankfurt)**. Then:

1. Project Settings → Database → Connection string. Two values:
   - `DATABASE_URL` = the **Transaction pooler** URI (port 6543) with
     `?pgbouncer=true&connection_limit=1` appended — this is what the serverless
     functions use.
   - `DATABASE_URL_UNPOOLED` = the **Direct connection** URI (port 5432) — what
     `prisma migrate deploy` uses during the build.
2. Project Settings → API: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`.
3. Storage → New bucket → name `nod-media`, **private**. Originals, generated versions,
   screenshots and reports go here (`lib/storage.ts`); they are served through signed
   URLs only.

If you add Supabase through the Vercel Marketplace instead, it injects differently named
variables. Map them: `DATABASE_URL` ← `POSTGRES_PRISMA_URL`, `DATABASE_URL_UNPOOLED` ←
`POSTGRES_URL_NON_POOLING`; the `SUPABASE_*` names match.

The demo deploy uses **Neon** from the Vercel Marketplace instead (free tier, EU). Its
integration injects `DATABASE_URL` and `DATABASE_URL_UNPOOLED` under exactly those
names, which is why the Prisma schema uses them.

### Media without Supabase — Vercel Blob

Neon has no file storage, so the demo keeps media in a **Vercel Blob** store.
`lib/storage.ts` picks Blob whenever `BLOB_READ_WRITE_TOKEN` exists and the Supabase
keys do not; every read still goes through the authorised `/api/media` proxy.

    vercel blob store add nod-media --region fra1     # answer Y, link to the project

The CLI only creates **public** stores, so also set `BLOB_ACCESS=public` — the blob URLs
are then reachable by anyone who knows a placement id. Fine for a demo behind fake
providers, not for a pilot: create the store as *private* in the dashboard instead
(Storage → Create → Blob → Private) and leave `BLOB_ACCESS` unset, or use Supabase.

If the database was seeded from your machine, the images are in your local `.storage/`
and not in the store. Push them once: pull the token (`vercel env pull .env.local`,
keep only `BLOB_READ_WRITE_TOKEN` and `BLOB_ACCESS`) and run `pnpm storage:push`.
Seeding with the token present writes straight to the store.

Seed data: after the first deploy, run once from your machine against the production
database (`DATABASE_URL=<direct url> pnpm db:seed`) if you want the demo brand,
campaigns and `ops@nod.se`. For a real pilot, skip the seed and create the brand from
`/ops/brands`. The ops account is whoever signs in at `/sign-in` with the address in
`OPS_EMAIL` — that row is created (or promoted) on first sign-in, so no database console
is needed.

## 2. Mail — Resend

1. resend.com → Domains → `joinbooga.se` is added (region eu-west-1). Resend shows three
   DNS records: a TXT for DKIM (`resend._domainkey`), and a TXT + MX on `send` for SPF
   and bounces. Add them at your DNS host and wait for "Verified" (minutes, occasionally
   an hour).
2. API Keys → Create → **Sending access** only, restricted to that domain.
3. Set `RESEND_API_KEY` and `EMAIL_FROM="Boogaa <hello@joinbooga.se>"` (the from-address
   must be on the verified domain, otherwise Resend rejects the send and the code is
   never delivered).

Until the domain is verified you can send from Resend's shared `onboarding@resend.dev`
address, but only to the email address on your Resend account — enough to test the
sign-in code loop, not enough for a second user.
Resend reports that refusal as an API error, which `lib/email.ts` treats as "not sent" —
so with `NOD_DEMO_LOGIN_CODE=1` every other address still gets the code on the page.
The demo deploy runs in exactly this mode until `joinbooga.se` is verified.

Every template lives in `lib/email.ts` in both languages; nothing else changes.

## 3. Vercel

Project is linked from this directory (`.vercel/` is git-ignored) and connected to
GitHub (`Ayuubartan/nod`, private): every push to `main` builds and deploys
production; pull requests get preview URLs. `vercel deploy --prod` from a laptop still
works but is no longer the normal path — push instead. CI (`.github/workflows/ci.yml`)
runs typecheck, lint and the test suite on the same push.
`powershell -NoProfile -File scripts/vercel-env.ps1` generates the two secrets and sets
the fixed configuration in one go; the rest you paste in Settings → Environment
Variables. The full list for **Production**:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | `https://<your-domain>` — used in emails, share links and OAuth redirects |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | from step 1 (injected automatically by the Neon or Supabase integration) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `SUPABASE_STORAGE_BUCKET` | `nod-media` |
| `BLOB_READ_WRITE_TOKEN`, `BLOB_ACCESS` | only without Supabase: injected by `vercel blob store add`; `public` for a CLI-created store |
| `RESEND_API_KEY`, `EMAIL_FROM` | from step 2 |
| `OPS_EMAIL` | your own address: it receives brand enquiries and is the ops login |
| `ENCRYPTION_KEY` | 32 random bytes, base64 — `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `BANKID_SUBJECT_SALT` | a long random string; **never change it** once participants are verified, or every subject hash stops matching |
| `NOD_MARKET` | `SE` |
| `NOD_FAKE_PROVIDERS` | `1` for a demo deploy (see below); **unset** for a real pilot |
| `NOD_DEMO_LOGIN_CODE` | `1` shows the sign-in code on the page while no mail provider is set, so a demo without Resend can be entered — by anyone with the URL. Remove it the moment `RESEND_API_KEY` exists. |

Push to `main`. Vercel builds, migrates, and deploys. The domain `joinbooga.se` is on
the project (apex redirects to `www`); at the registrar set `A @ → 216.198.79.1` and
`CNAME www → 158c83199c6212ca.vercel-dns-017.com`. `NEXT_PUBLIC_SITE_URL` is
`https://joinbooga.se`.

### `NOD_FAKE_PROVIDERS=1` — read this before a real pilot

With the flag set, BankID verification, Instagram connection, Stripe deposits and Swish
payouts are all simulated: anyone can "verify", any handle "connects", any deposit
"clears". That is exactly right for showing the product to a brand, and exactly wrong
for the first real campaign. The flag is one variable so that switching over is one
change; each provider then activates as soon as its own keys exist (docs/06).

### What is not switched on by this runbook

- **Inngest** (timeouts, verification pipeline, payout batches). Add the Inngest
  integration from the Vercel Marketplace; it sets `INNGEST_EVENT_KEY` and
  `INNGEST_SIGNING_KEY` and registers `/api/inngest`. Until then, timed states do not
  expire on their own. Free tier is enough for a pilot.
- **Stripe** webhook: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, endpoint
  `https://<domain>/api/webhooks/stripe`.
- **Meta**: `META_APP_ID`/`META_APP_SECRET`, redirect `https://<domain>/api/auth/instagram/callback`.
- **Criipto** (BankID), **Swish**, **46elks/Twilio**: docs/06.
- **Sentry / PostHog**: set the DSN/key and they are live; nothing else to do.

## Checks after the first deploy

1. `https://<domain>/` renders the landing page in Swedish; the `EN` toggle works.
2. `/brand/sign-in` with a brand address mails a code within seconds (Resend →
   Emails shows it). The code signs you in and only that brand's campaigns show.
3. `/sign-in` with a fresh address lands in onboarding.
4. `/dev` is a 404.
5. `/brand/campaigns` in a private window redirects to the sign-in.
6. Upload a screenshot on a placement; it appears in the Supabase bucket (or the Blob
   store), and the image is served from `/api/media/...`, not a public URL.

## Rate limiting on Vercel

`lib/rate-limit.ts` is in-memory per function instance. On Vercel that means the limits
(five code requests per address per 15 min, etc.) are enforced per warm instance, not
globally. For a pilot this is fine — the code itself still expires, burns after five
guesses and is single-use, which is the security boundary. If abuse ever matters, swap
the store for Upstash Redis (one file).
