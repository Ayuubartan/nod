# DPIA (draft)

**DRAFT — for the lawyer's review.**

docs/07 §3 says: "**[LAWYER]** decide whether one is required given BankID + image
processing at scale; draft it regardless — it's a good spec." This is that draft. It is
written as an honest assessment, including the parts that do not flatter the product.

## 1. Is a DPIA required?

Probably yes. Under Article 35 a DPIA is required for processing likely to result in a
high risk. Three of IMY's criteria plausibly apply:

- **Systematic and extensive evaluation** — Boogaa scores participants for fraud, and that
  score decides whether they are paid. That is automated decision-making with a financial
  effect on a person.
- **Processing at scale** — the pilot is 200–300 people, which is not "at scale". The
  thesis is 50,000, which is.
- **Innovative use of technology** — placing brand imagery into a person's own photograph
  and publishing it under their name is not a settled processing pattern.

The pilot arguably falls under the thresholds. The model Boogaa is testing does not. Doing
the assessment now, at 300 people, is cheaper than doing it at 50,000.

## 2. What is processed, and why

| Data | Purpose | Basis |
|---|---|---|
| Phone/email, city, age bracket | Account, eligibility | Contract |
| BankID subject hash, birth year | One person per account; 18+ | Contract; legal obligation |
| Social handle, follower count, average views, categories | Eligibility and payout calculation | Contract |
| Social access token (encrypted) | Reading views for verification | Contract |
| Uploaded photos and videos | The product | Contract |
| Placement choices and regenerations | Running the marketplace | Contract |
| The same, anonymised | Improving the placement engine | **Consent**, separate and revocable |
| Post URL, view counts | Verification and payment | Contract |
| Swish number (encrypted) | Payment | Contract |
| Fraud signals | Preventing fraud | Legitimate interest — balanced below |
| Ledger, audit | Bookkeeping | Legal obligation |

## 3. Necessity and proportionality

**What Boogaa deliberately does not do**, each of which was an available design:

- It does not store a personnummer. The broker returns one; only the birth year is kept,
  and as a salted hash for the identifier.
- It does not request any write scope on a social platform. It cannot post, edit, follow
  or message, so the participant's account cannot be acted on by Boogaa at all.
- It does not publish. The participant publishes, after seeing and approving the result.
- It does not show brands who participants are. Brands get handles and public links.
- It does not use images for training without separate, unbundled, default-off consent.
- It does not run session replay on surfaces where personal photos appear.

**Data minimisation is the design, not a policy.** The retention schedule deletes
originals 90 days after a placement ends and screenshots 30 days after a decision.

## 4. Risks and mitigations

| Risk | Severity | Mitigation | Residual |
|---|---|---|---|
| Identity data leaks | High | No personnummer stored. Hash is salted with a server secret and unusable elsewhere. RLS gives `Identity` no policy at all — only the service role reads it. Scrubber redacts identity numbers from every log and Sentry event | Low |
| A participant's private photo is exposed | High | Private bucket, signed URLs, an authorising proxy route, and RLS. A brand sees only the versions on its own campaign | Low–medium |
| Fraud score wrongly withholds pay | Medium | The score never rejects on its own — it flags for a human, with the full factor breakdown, on a 48h SLA. v1 stays dormant below 20 decided placements. Calibration is a reviewed constant, not an ops toggle | Medium |
| Money moves incorrectly | High | Append-only ledger, balances derived by summing, reconciliation invariant asserted in tests and in the reconcile job, deterministic payout instruction ids | Low |
| Participant does not understand they are advertising | Medium | Disclosure quiz in onboarding; disclosure is a payable condition; the checklist before posting | Low |
| A participant is pressured into placements | Medium | No quotas, no streaks, no penalties for not claiming. Rejecting a placement is free and costs nothing | Low |
| Re-identification from training exports | Medium | Per-export pseudonyms, no absolute timestamps, no brand or campaign names, no handles | Low |
| Token compromise | Medium | AES-256-GCM at rest, read-only scopes, daily refresh, `DISCONNECTED` on failure | Low |
| Under-18 participation | High | BankID before the first claim; no under-18 age bracket exists anywhere in the product; no parental-consent path | Low |

## 5. The legitimate-interest balancing test for fraud

**Interest:** Boogaa pays real money on self-reported and API-reported view counts. Without
fraud detection the marketplace is trivially drained, which harms brands (paying for
nothing), honest participants (a devalued market), and Boogaa.

**Necessity:** No less intrusive alternative achieves it. The data used is data Boogaa
already holds for payment — view counts, the account's own baseline, account age,
engagement, and the participant's own history.

**Impact on the individual:** A flag delays payment; it does not deny it. A human decides
within 48 hours and must record a reason. The participant is not told they are under
review before a human has looked, which is deliberate — telling them invites tampering
and is unfair if the flag is wrong. The breakdown is retained, so a decision can be
explained afterwards.

**Conclusion:** the interest holds, on the condition that no automated flag ever
constitutes a final decision. It does not: `flagForOps` moves a placement to `FLAGGED`,
and only `clearFlagAndQualify` or `confirmFraud` — both requiring an ops actor and a
written reason — resolve it.

## 6. Automated decision-making (Article 22)

The fraud score does not make a decision with legal or similarly significant effect,
because it does not decide. It routes to a human. Verification checks 1–3 (account match,
disclosure, media match) *are* automated and do reject — but they are objective,
evidenced, and disclosed to the participant in the terms before they take part, and the
disclosure check carries a fix window.

**[LAWYER]** to confirm this reading, in particular whether an automated `REJECTED` on
check 2 needs an explicit human-review route rather than the 12-hour fix window.

## 7. Consultation

Not yet performed. Before scaling past the pilot: the lawyer, the accountant on client
funds, and — worth doing and cheap — a handful of actual participants asked whether they
understood what they agreed to.

## 8. Outstanding

- **[LAWYER]** Is a DPIA formally required at pilot scale, and at what point does it
  become so?
- **[LAWYER]** The `subjectHash` retention basis (see the retention schedule).
- **[LAWYER]** Article 22 as above.
- **[LAWYER]** Whether Boogaa and a brand are independent controllers or joint controllers
  for placement data. The agreement asserts independent; that should be checked.

*Last updated: 2026-09-07.*
