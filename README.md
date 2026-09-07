# NOD

**NOD turns the social reach of ordinary people into advertising inventory that brands can buy at scale.**

Brands fund campaigns. Everyday people place those brands naturally inside content they were already
going to post, publish it disclosed to their own accounts, and get paid on verified views. NOD keeps a
spread on the media spend.

Specs live in [`docs/`](./docs); [`CLAUDE.md`](./CLAUDE.md) holds the non-negotiables.

## Running it

```bash
pnpm install
docker compose up -d          # Postgres on :5432
cp .env.example .env          # then set ENCRYPTION_KEY and BANKID_SUBJECT_SALT
pnpm prisma migrate deploy
pnpm db:seed
pnpm dev
```

Generate an encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Every external provider has a fake that activates when its key is absent, so the whole product —
onboarding, BankID, claiming, generation, verification, payouts — is walkable with no third-party
credentials at all. `NOD_FAKE_PROVIDERS=1` forces them everywhere.

To act as a signed-in user in development without Supabase, set `NOD_DEV_AUTH_ID` to a seeded
`User.authId` (`seed-p1`, `seed-p2`, … or `seed-ops` for the ops console).

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test    # 202 unit + integration tests
pnpm e2e                                    # Playwright smoke flows
```

Integration tests run against a `nod_test` database and truncate between tests:

```bash
docker exec nod-db psql -U postgres -c "CREATE DATABASE nod_test"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/nod_test?schema=public" pnpm prisma migrate deploy
```

## Where things are

| Path | What |
|---|---|
| `lib/money/` | `rates.ts` is the single source of truth for every price. `calc.ts` is pure and fully tested. `ledger.ts` is append-only; `balances.ts` derives every balance by summing. |
| `lib/state/` | One file per lifecycle: `campaign`, `placement`, `participant`, `money`, plus `verification`. Every transition validates its from-state, writes an `AuditLog` row and emits an event. `transition.ts` is the only place a `state` column changes. |
| `lib/integrations/` | Instagram, BankID, Stripe, Swish, and the placement engine — each an interface with a real, a fake, and (where the pilot needs one) a manual implementation. |
| `inngest/` | A timeout job for every timed state, the publish→hold→verify→settle pipeline, and the scheduled jobs (go-live, token refresh, payouts, retention, GDPR erasure). |
| `app/(marketing)/` | Landing page, `/brands`, waitlist, legal drafts. Static. |
| `app/(participant)/` | Onboarding, marketplace, the claim flow, wallet, accounts, settings. |
| `app/(brand)/` | Campaign builder, dashboard, Tier B review queue, PDF report. |
| `app/(ops)/` | Campaign review, the manual generation queue, verification and fraud, payout batches, participants, brands, flags, audit. |
| `legal/` | Privacy policy and participant terms, sv + en, marked DRAFT pending legal review. |

## Three rules worth knowing before you change anything

1. **Money is integers in öre, and balances are never stored.** `campaign.available`, `reserved`,
   `spent` and `wallet.available` are always sums over `LedgerEntry`. `reconciles()` asserts the
   invariant and the tests check it after every flow.
2. **Disclosure is a payable condition.** Verification check 2 rejects a placement with no
   disclosure, and there is no override — not in the API, not for ops. The tests assert the absence
   of one.
3. **NOD never posts on anyone's behalf.** No social API write scope exists in the codebase;
   `assertNoWriteScopes` throws at module load if one is ever added.

## Turning on the M5 automations

Everything in Milestone 5 is written and tested. Each piece activates from configuration,
not a deploy, and each has a working fallback until it does.

| Set these | And this happens |
|---|---|
| `INPAINT_PROVIDER` + `INPAINT_API_KEY` | Placements render automatically. The ops generation queue becomes review-only; on any provider failure the placement falls back to it rather than costing the participant their 48 hours. |
| `SWISH_CERT_PATH` + `SWISH_PAYER_ALIAS` | Payouts go through the Swish API instead of the CSV. Instruction ids are deterministic per (batch, wallet), so a retry cannot pay twice; an ambiguous result is queued for a human, never retried. |
| `NOD_MARKET=DK` | The broker asks for MitID instead of BankID. `SE`, `NO` and `FI` work the same way. |
| Nothing | Fraud v1 turns itself on once a campaign has 20 decided placements. The fill model switches from an upper-bound heuristic to measured claim and completion rates the moment the first campaign closes, and tells the brand which one it used. |

## Seeing it locally

`pnpm dev`, then open `/dev`. It lists every seeded participant, brand user and ops
account with a button that signs you in as them — NOD has no password login, so this is
the only practical way to walk the three surfaces. The page 404s in production and the
cookie it sets is ignored there.

`pnpm db:reset` puts the demo data back. You will want it: exercising the product leaves
real consequences behind, because it is supposed to. Reject a placement for a missing
disclosure and the participant picks up a strike and gets flagged, which correctly blocks
their next claim.
