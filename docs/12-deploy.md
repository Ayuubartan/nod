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
   - `DIRECT_URL` = the **Direct connection** URI (port 5432) — what
     `prisma migrate deploy` uses during the build.
2. Project Settings → API: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`.
3. Storage → New bucket → name `nod-media`, **private**. Originals, generated versions,
   screenshots and reports go here (`lib/storage.ts`); they are served through signed
   URLs only.

If you add Supabase through the Vercel Marketplace instead, it injects differently named
variables. Map them: `DATABASE_URL` ← `POSTGRES_PRISMA_URL`, `DIRECT_URL` ←
`POSTGRES_URL_NON_POOLING`; the `SUPABASE_*` names match.

Seed data: after the first deploy, run once from your machine against the production
database (`DATABASE_URL=<direct url> pnpm db:seed`) if you want the demo brand,
campaigns and `ops@nod.se`. For a real pilot, skip the seed and create the brand from
`/ops/brands` — but note that then no ops user exists; create one with
`prisma studio` (or a one-line `prisma.user.create` with `role: 'OPS'`) before you lock
the door behind yourself.

## 2. Mail — Resend

1. resend.com → Domains → Add `nod.se` (or the domain you send from). Resend shows three
   DNS records: a TXT for SPF, a CNAME/TXT for DKIM, and an MX for bounces. Add them at
   your DNS host and wait for "Verified" (minutes, occasionally an hour).
2. API Keys → Create → **Sending access** only, restricted to that domain.
3. Set `RESEND_API_KEY` and `EMAIL_FROM="NOD <hello@nod.se>"` (the from-address must be
   on the verified domain, otherwise Resend rejects the send and the code is never
   delivered).

Until the domain is verified you can send from Resend's shared `onboarding@resend.dev`
address, but only to the email address on your Resend account — enough to test the
sign-in code loop, not enough for a second user.

Every template lives in `lib/email.ts` in both languages; nothing else changes.

## 3. Vercel

Project is linked from this directory (`.vercel/` is git-ignored).
`powershell -NoProfile -File scripts/vercel-env.ps1` generates the two secrets and sets
the fixed configuration in one go; the rest you paste in Settings → Environment
Variables. The full list for **Production**:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | `https://<your-domain>` — used in emails, share links and OAuth redirects |
| `DATABASE_URL`, `DIRECT_URL` | from step 1 |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `SUPABASE_STORAGE_BUCKET` | `nod-media` |
| `RESEND_API_KEY`, `EMAIL_FROM`, `OPS_EMAIL` | from step 2 |
| `ENCRYPTION_KEY` | 32 random bytes, base64 — `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `BANKID_SUBJECT_SALT` | a long random string; **never change it** once participants are verified, or every subject hash stops matching |
| `NOD_MARKET` | `SE` |
| `NOD_FAKE_PROVIDERS` | `1` for a demo deploy (see below); **unset** for a real pilot |

Then `vercel --prod`. Vercel builds, migrates, and gives you a URL. Point the domain at
it under Settings → Domains and set `NEXT_PUBLIC_SITE_URL` to match.

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
6. Upload a screenshot on a placement; it appears in the Supabase bucket, and the
   image is served from `/api/media/...` (signed), not a public URL.

## Rate limiting on Vercel

`lib/rate-limit.ts` is in-memory per function instance. On Vercel that means the limits
(five code requests per address per 15 min, etc.) are enforced per warm instance, not
globally. For a pilot this is fine — the code itself still expires, burns after five
guesses and is single-use, which is the security boundary. If abuse ever matters, swap
the store for Upstash Redis (one file).
