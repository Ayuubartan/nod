# 07 — Compliance

Compliance is a product feature: disclosed, consented, verified placements are what make the inventory worth buying. This file is the spec; a lawyer reviews the output before launch. Items marked **[LAWYER]** or **[ACCOUNTANT]** are questions that must be answered in writing before the first paid campaign.

## 1. Disclosure (marketing law)

- Legal frame: Sweden's Marknadsföringslagen (MFL) and Konsumentverket guidance on influencer marketing; EU Unfair Commercial Practices Directive; platform branded-content rules.
- **Rule in product:** disclosure is a payable condition. Verification check #2. No disclosure → `REJECTED`. No ops override.
- Default disclosure text (campaign-editable within a guard that requires the words *Reklam* or *Annons* at the start for Swedish audiences):
  - sv: `Reklam – i samarbete med {brand}`
  - en: `Ad – in partnership with {brand}`
- Placement: first line of the caption / Story text, not buried in hashtags. Plus Instagram's Paid Partnership label where available.
- Onboarding includes a one-question disclosure check; record `disclosureQuizAt`.
- Campaign builder shows the brand the exact disclosure that will be used; brand cannot remove it.
- **[LAWYER]** Confirm the default wording and placement meet current Konsumentverket guidance for Stories and Reels specifically.

## 2. Consent & control (participant)

- Participant chooses the brand, chooses the placement, approves every output, and publishes themselves. NOD never posts, edits after approval, or messages on their behalf.
- Terms (participant) must state plainly: what NOD reads from their account; that they publish themselves; that undisclosed posts aren't paid; that earnings may be taxable income for them and NOD provides an annual summary; strike and suspension rules; that they can withdraw at any time and open placements complete.
- **Training-data consent is separate, unbundled, default off**, and revocable in settings. Text: *"Let NOD use anonymised versions of my placement choices and images to improve the placement engine."* Revocation stops future use; already-anonymised data is not re-identifiable and is retained.

## 3. GDPR

- Lawful bases: contract (running the marketplace), consent (training data, marketing email), legitimate interest (fraud prevention — document the balancing test).
- Data minimisation table:

| Data | Store? | Where | Retention |
|---|---|---|---|
| Personnummer | **No** | — | — |
| BankID subject hash, birth year, verified date | Yes | `Identity` | Hash retained after removal; rest erased on request |
| Swish number | Yes, encrypted | `User` | Until account deletion |
| Instagram token | Yes, encrypted | `SocialAccount` | Until disconnect |
| Original images | Yes | Supabase Storage | 90d after placement terminal, unless training consent |
| Screenshots | Yes | Storage | 30d after verification decision |
| View counts | Yes | `ViewSnapshot` | 7 years (bookkeeping support) |
| Ledger, audit | Yes | DB | 7 years |

- Brand-facing data: aggregated only. Brands see handles and post links (public information) on placements, never email, phone, Swish, age, or identity data.
- Rights: `/settings` → download my data (JSON export job) and delete account (30-day grace, then erasure job; ledger and audit retained under bookkeeping exemption; `subjectHash` retained to block re-registration — **[LAWYER]** confirm this retention basis).
- Processors: Supabase, Vercel, Stripe, Resend, PostHog, Sentry, BankID broker, Meta. DPA with each; list them in the privacy policy.
- DPIA: **[LAWYER]** decide whether one is required given BankID + image processing at scale; draft it regardless — it's a good spec.

## 4. Platform terms

- Instagram/TikTok: read-only API use; no automation of posting, liking, following; no scraping. Verification fallbacks documented in `06-integrations.md`.
- Branded content: use the Paid Partnership label where available; brand may be asked to approve NOD's participants as partners in Business Suite — treat as an optional enhancement, not a dependency.

## 5. Money

- Brand deposits are client funds. Segregated bank account. **[ACCOUNTANT]** Is NOD an agent (fee revenue only) or principal (gross revenue)? This decides VAT (moms) treatment, revenue recognition and the income statement shape. The fee-spread structure supports agent; confirm.
- Participant payouts: **[ACCOUNTANT]** Does NOD have a reporting obligation (kontrolluppgift) on amounts paid to private individuals? Threshold? What summary must NOD provide participants annually?
- **[ACCOUNTANT/LAWYER]** At what volume does holding and disbursing funds require a payment-institution arrangement or partner? Plan the trigger, not the answer.

## 6. Brand safety & content

- Campaign exclusions enforced at claim (categories) and pre-check (obvious violations).
- Prohibited categories for NOD regardless of brand: alcohol and tobacco to under-25 audiences, gambling, political advertising, anything requiring age-gating beyond 18+. Flag-driven list.
- Participants must be 18+. No exceptions, no "parental consent" path.

## 7. Documents to produce (drafts live in `legal/` in the repo)

- Participant terms (sv/en)
- Brand agreement (campaign terms, prepayment, refund, dispute window, disclosure obligation, pause rights)
- Privacy policy (sv/en) with processor list
- Training-data consent text
- Cookie notice (minimal: PostHog, no ad pixels)
- Internal: data-retention schedule, incident response one-pager, DPIA draft
