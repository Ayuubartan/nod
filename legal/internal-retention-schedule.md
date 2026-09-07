# Data retention schedule (internal)

**DRAFT — for the lawyer's review.**

The authoritative version of this is the code: `inngest/scheduled.ts` contains
`retentionSweep` and `gdprErasure`, and they run on cron. This document exists so a
reviewer can check the intent against the implementation without reading TypeScript.

## Schedule

| Data | Where | Retained | Enforced by |
|---|---|---|---|
| Original uploaded images | Supabase Storage, `originals/` | 90 days after the placement reaches a terminal state — unless the participant gave training consent, in which case an anonymised derivative is kept and the original still goes | `retentionSweep`, daily 02:00 |
| Generated placement versions | Storage, `versions/` | Same as originals | `retentionSweep` |
| Verification screenshots | Storage, `screenshots/` | 30 days after the verification decision | `retentionSweep` |
| View counts (`ViewSnapshot`) | Database | 7 years — they evidence what a brand was charged and a participant was paid | Not deleted |
| Ledger (`LedgerEntry`) | Database | 7 years, Swedish Bookkeeping Act | Not deleted; append-only by rule and by RLS |
| Audit log (`AuditLog`) | Database | 7 years | Not deleted |
| BankID subject hash (`Identity.subjectHash`) | Database | Indefinitely, including after account removal | Deliberately excluded from the erasure job |
| Birth year, verification date | Database | Erased with the account | `gdprErasure` |
| Social access tokens | Database, encrypted | Until disconnect, then nulled | `gdprErasure`, disconnect flow |
| Swish number | Database, encrypted | Until account deletion | `gdprErasure` |
| Email, city, age bracket, push subscription | Database | Until account deletion | `gdprErasure` |
| Post URLs | Database | Nulled on erasure | `gdprErasure` |
| Waitlist entries | Database | Until the person asks, or the beta closes | Manual |
| Training exports | Storage, `training/` | Indefinitely — anonymised, not attributable | Not deleted |

## The two retentions that need a lawyer's sign-off

**1. `Identity.subjectHash` is kept forever, including after erasure.**

It is the only thing that stops a removed participant re-registering, which is what
enforces "one person, one account" and the suspension rules. It is a salted SHA-256 of
the broker's subject identifier — not reversible, not a personnummer, and useless outside
Booga's own database because the salt is a server secret.

docs/07 §3 flags this as **[LAWYER]**: confirm the retention basis. Our position is
legitimate interest in fraud prevention and enforcement of a suspension, documented here
as the balancing test. If that does not hold, the alternative is that a suspended
participant can return by deleting and re-registering, which defeats the strike system.

**2. Ledger and audit are kept for 7 years and are not erasable.**

Bookkeeping obligation. Both contain a `userId` and are therefore personal data, but the
obligation is a legal one and overrides an erasure request for those records. The privacy
policy says so plainly.

## Erasure flow

1. Participant requests deletion in Settings. `deletionRequestedAt` is set.
2. A 30-day grace period runs. The participant can cancel; open placements continue and
   are paid, because they are owed the money.
3. `gdprErasure` runs daily and processes anything past the grace period: nulls tokens,
   Swish number, email, city, age bracket, push subscription, original image paths and
   post URLs; sets the account to `REMOVED`; writes a `GDPR_ERASURE` audit row.
4. `Identity.subjectHash`, the ledger and the audit log survive, per above.

## What is deliberately never collected

Personnummer. The broker returns one; `birthYearFromSubject` reads the year and the value
goes out of scope in that function. It is never returned to a caller, never logged — the
scrubber in `lib/scrub.ts` redacts it from any string that reaches a log or Sentry — and
never written.

*Last updated: 2026-09-07.*
