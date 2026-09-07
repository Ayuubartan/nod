# Training-data consent

**DRAFT — under review by a lawyer before launch.**

This is the exact text and the exact rules for the training-data consent required by
docs/07 §2. It is a separate document because the consent itself must be separate: it is
never bundled with the terms, and accepting the terms does not grant it.

## The text shown to the participant

**Swedish** (`onboarding.training.consent` in `lib/i18n/sv.json`):

> Låt Booga använda anonymiserade versioner av mina placeringsval och bilder för att
> förbättra placeringsmotorn.

**English** (`onboarding.training.consent` in `lib/i18n/en.json`):

> Let Booga use anonymised versions of my placement choices and images to improve the
> placement engine.

Shown beneath it, in both languages:

> Entirely optional. Doesn't affect your payout. You can change it any time in settings.

## The rules this consent operates under

1. **Separate.** It is its own checkbox on its own onboarding screen (step 6), not a
   clause inside the terms and not bundled with anything else.
2. **Default off.** The box is unticked. A participant who clicks through onboarding
   without reading has not consented.
3. **Not a condition.** Declining changes nothing about eligibility, payouts, or which
   campaigns a participant sees. The wording says so, and the code contains no branch on
   `trainingConsent` other than the export itself.
4. **Revocable.** Settings has a toggle. Turning it off takes effect immediately.
5. **Checked at export, not at capture.** The export job filters on the consent flag as
   it stands when the export runs, so revoking it stops future use without needing a
   retroactive deletion pass. This is implemented in `inngest/training.ts`.
6. **Anonymised.** The export carries no user id, no handle, no account id and no
   absolute timestamps. Identifiers are pseudonymised per export, so two exports cannot
   be joined to re-identify a person.

## What the export actually contains

Per placement: the chosen region, the candidate regions that were offered, the asset
*type* (never its name, which would identify the brand), the number of regenerations,
whether the participant approved it, whether the brand approved it, the rejection reason
if any, the qualified view count, and the sequence of participant actions with timings
relative to the claim.

## What it does not contain

No user id, no handle, no email, no phone, no Swish number, no identity data, no brand
name, no campaign name, no absolute timestamps, no post URLs.

## Retention

Already-anonymised exports are retained after revocation, because they cannot be traced
back to a person and therefore cannot be deleted per-person. The participant-facing text
says this plainly rather than implying a deletion Booga cannot perform.

*Last updated: 2026-09-07.*
