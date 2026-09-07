# Incident response (internal, one page)

**DRAFT — for the lawyer's review.**

NOD holds three things worth attacking: participants' identity verification, their money,
and brands' prepaid budgets. This page is what to do when something goes wrong, written
to be usable at 03:00 by whoever is awake.

## Severity

| | What it means | Examples | Clock |
|---|---|---|---|
| **S1** | Personal data exposed, or money moved incorrectly | Identity table read by an unauthorised party; a payout batch paid twice; a client-funds discrepancy | Start immediately, any hour |
| **S2** | A core flow is down | Nobody can claim; verification is not running; Stripe webhooks failing | Within 1 hour, business hours or not |
| **S3** | Degraded but contained | Ops queue backing up; a provider is slow; one campaign's numbers look wrong | Next business day |

Anything involving `Identity`, `LedgerEntry`, or a Swish number is S1 until proven
otherwise. Assume the worst and downgrade with evidence, never the reverse.

## First 30 minutes

1. **Write it down.** Open a timestamped note. Every action from here goes in it — this
   becomes the regulator-facing record and nobody remembers accurately afterwards.
2. **Stop the bleeding, do not tidy up.** Revoke the credential, disable the flag, pause
   the campaign. Do not delete logs, do not redeploy over the evidence, do not "fix" the
   data before it has been captured.
3. **Scope it.** How many people, which data, over what window. `AuditLog` answers "what
   changed and who did it" for every state transition; `LedgerEntry` answers every money
   question and is append-only, so it cannot have been quietly rewritten.
4. **Decide if it is S1.** If personal data may have left NOD's systems, the 72-hour
   GDPR notification clock has already started — from the moment of awareness, not the
   moment of confirmation.

## Containment actions available

| Action | How |
|---|---|
| Stop all new claims | Ops → Flags, or pause the campaigns |
| Stop all payouts | Do not open a batch; a batch already exported is paid by hand and can simply not be paid |
| Revoke a leaked Supabase key | Supabase dashboard; rotate `SUPABASE_SERVICE_ROLE_KEY` in Vercel |
| Rotate the encryption key | `ENCRYPTION_KEY` — note this invalidates every stored token and Swish number, which forces reconnection and re-entry. It is a real cost; use it when the key is genuinely suspect |
| Rotate the BankID salt | `BANKID_SUBJECT_SALT` — **do not**, except on legal advice. It breaks the duplicate-registration block permanently, because existing hashes cannot be recomputed |
| Disconnect a provider | Unset its env var; every integration falls back to its manual path by design |

## Notification

- **Participants** — if their data was exposed, in plain Swedish, with what was exposed
  and what it means for them. Not a legal notice.
- **Brands** — if their campaign data or budget was affected.
- **IMY** (Integritetsskyddsmyndigheten) — within **72 hours** of becoming aware, where
  the breach is likely to risk people's rights. Late is worse than incomplete: file with
  what is known and supplement.
- **Processors** — Supabase, Vercel, Stripe, the BankID broker, Meta, as relevant.

The decision to notify is not the responder's alone. Escalate to the founder and the
lawyer; if they cannot be reached inside the window, notify anyway.

## Money incidents specifically

The ledger is append-only and balances are derived by summing, so a wrong number is
always a wrong *entry*, never a corrupted balance. Do not update rows. Correct with a
compensating `ADJUSTMENT` entry, memo explaining it, and an audit row.

`assertCampaignReconciles()` is the check: deposits must equal available + reserved +
spent + refunded + rolled over. Run it against every affected campaign before declaring
the incident closed.

If a payout went out twice, the Swish instruction id is deterministic per (batch,
wallet) — check whether the second one was actually accepted before assuming a double
payment.

## After

Within a week: a written post-mortem covering timeline, root cause, what the blast radius
actually was, and what changed so it cannot recur. No blame on a person; a system that
lets one person cause an S1 is the finding.

## Contacts

| Role | Who |
|---|---|
| Founder | *to fill in* |
| Lawyer | *to fill in* |
| Accountant (money incidents) | *to fill in* |
| Supabase / Vercel / Stripe support | dashboards |
| IMY | imy.se |

*Last updated: 2026-09-07.*
