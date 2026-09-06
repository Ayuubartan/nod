# 05 — Pricing & Economics

All numbers in SEK; stored in öre. Single source of truth in code: `lib/money/rates.ts`. The landing-page estimator, campaign builder preview and payout calculator all import from it.

## The model in one line

Brand sets an **all-in** price. Participant receives **all-in × (1 − take rate)**. The spread is NOD's revenue, recognised per placement when it qualifies. Brands prepay.

## Pilot price card (defaults + floors)

| Parameter | Default (brand sets) | Floor | Notes |
|---|---|---|---|
| CPM (per 1,000 qualified views) | 60 kr | 40 kr | Meta blended in SE ≈ 90–140 kr for narrow 18–25 audiences; awareness buys ≈ 60–100 kr. We sit at or under. |
| Fixed per approved placement | 30 kr | 20 kr | Makes a 450-view Story worth posting. Optional in CPM-only template. |
| Bonus (Hybrid+bonus) | 50 kr at 5,000 views | — | Brand-defined |
| View floor | 100 qualified views | 50 | Below floor → fixed only. **Never a 1k minimum.** |
| Take rate | 28% | — | Snapshotted on `PayoutTemplate` at funding; never changes mid-campaign |
| Per-person cap | 2 placements / campaign | 1 | Across all their accounts |
| Per-placement max | 500 kr | — | Caps reservation; brand-adjustable |
| Credit-terms fee (invoice, net-30) | 4% | — | 0% on prepaid card |
| Wallet payout threshold | 100 kr | — | Swish within 48h once reached |
| Referral bonus | 25 kr to referrer | — | Paid when referred user's first placement is `QUALIFIED`; funded from NOD margin, not campaign budget |

Floors and defaults are `Flag`s, editable by ops without deploy.

## Templates (brand picks one; numbers editable above floors)

| Template | Brand pays | Best for |
|---|---|---|
| `FIXED` | fixed per placement | Brands who want guaranteed volume of posts |
| `CPM` | CPM only | Brands with strict cost-per-view KPI; fills slower with small accounts |
| `HYBRID` (default) | fixed + CPM | Almost every awareness campaign |
| `HYBRID_BONUS` | fixed + CPM + bonus at threshold | Campaigns wanting a few breakout posts |

Participant sees only their **net** numbers: "20 kr per post + 43 kr per 1,000 views" (60 × 0.72 ≈ 43.2 → round down to whole kr for display, exact öre in ledger).

## Formulas

```ts
// lib/money/calc.ts — pure, unit-tested
takeRateBps = 2800

participantShare(oreAllIn)  = floor(oreAllIn × (10000 − takeRateBps) / 10000)
nodTake(oreAllIn)           = oreAllIn − participantShare(oreAllIn)

reservationOre(template, account) =
  min(
    template.fixedOre + template.cpmOre × ceil(2 × account.avgViews30d / 1000) + (template.bonusOre ?? 0),
    campaign.perPlacementMax
  )

payoutAllInOre(template, qualifiedViews) =
  qualifiedViews < template.viewFloor
    ? template.fixedOre
    : template.fixedOre
      + floor(template.cpmOre × qualifiedViews / 1000)
      + (template.bonusAtViews && qualifiedViews >= template.bonusAtViews ? template.bonusOre : 0)

settle(placement) {
  allIn   = min(payoutAllInOre(...), placement.reservationOre)
  toUser  = participantShare(allIn)
  toNod   = nodTake(allIn)
  release = placement.reservationOre − allIn         // back to campaign.available
  // ledger: SETTLE(allIn), PAYOUT_ACCRUE(toUser), TAKE(toNod), RELEASE_RESERVATION(release)
}

effectiveCpm(campaign) = campaign.spent / (Σ qualifiedViews / 1000)
```

Rounding: participant share rounds **down** to the öre; NOD keeps the remainder. Reservation rounds **up** to the nearest krona.

## Worked examples (defaults, 28%)

| Account avg views | Reservation | Actual views | Brand pays | Participant | NOD |
|---|---|---|---|---|---|
| 450 | 30 + 60×1 = 90 kr | 450 | 30 + 27 = 57 kr | 41.04 kr | 15.96 kr |
| 1,500 | 30 + 60×3 = 210 kr | 1,500 | 30 + 90 = 120 kr | 86.40 kr | 33.60 kr |
| 5,000 | 30 + 60×10 = 630 → cap 500 kr | 5,000 | 30 + 300 = 330 kr | 237.60 kr | 92.40 kr |
| 300 | 90 kr | 8,000 (spike) | capped at 90 kr; 7,500 views reported as free reach | 64.80 kr | 25.20 kr |

Campaign-level: 5,000 placements averaging 1,500 views → 7.5M qualified views, brand spends ~600k kr, effective CPM ≈ 80 kr, NOD ≈ 168k kr.

## Why these numbers (for the founder, not the code)

- Under Meta for the same audience so the first sales call is easy; the real argument is quality (disclosed, contextual, BankID-verified), not price.
- Fixed component exists because the thesis is *everyday* accounts; CPM alone pays them 20 kr and the sharing loop dies.
- 28% is a placeholder. The pilot measures what brands pay and what participants accept; the gap is the real take rate. Expect 22–35%.
- Never charge participants a visible fee. Never take a "processing fee" instead of a spread — it can't cover generation, verification, BankID and payments.

## What the pilot must report back into this file

- Actual fill rate at default price
- Actual avg qualified views by follower bracket
- Brand's own Meta CPM (ask in the first call — the only benchmark that matters)
- Participant re-participation rate at default payouts
