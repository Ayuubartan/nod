/**
 * Fill-rate estimate — docs/02 B1 step 5, and docs/09 M5 task 5:
 * "Fill-rate model from campaign-1 data replacing the heuristic."
 *
 * The heuristic the builder shipped with answers "how many placements can this budget
 * buy, out of how many eligible accounts". That is an upper bound, not a forecast: it
 * assumes every eligible account claims. Campaign 1 tells us what share actually does.
 *
 * So the model here is deliberately the simplest thing that uses real data honestly:
 * a claim rate and a completion rate measured from closed campaigns, applied to the
 * eligible population, with the heuristic as the fallback until there is history.
 *
 * It reports which basis it used, because a brand being shown a forecast deserves to
 * know whether it came from data or from arithmetic.
 */

import { prisma } from './db'
import { reservationOre, type Template } from './money/calc'

export type FillEstimate = {
  /** Expected share of the budget consumed, 0..100. */
  percent: number
  /** Expected days to reach it. */
  days: number
  /** How many placements the budget can afford at this price. */
  placementsAffordable: number
  /** How many eligible accounts exist for this audience. */
  eligibleAccounts: number
  /** Where the numbers came from — shown to the brand. */
  basis: 'model' | 'heuristic'
  /** Campaigns the model learned from. Zero when the basis is the heuristic. */
  sampleSize: number
}

export type HistoricalRates = {
  /** Share of eligible accounts that claimed, 0..1. */
  claimRate: number
  /** Share of claims that reached PAID, 0..1. */
  completionRate: number
  /** Median days from go-live to the last settled placement. */
  medianDaysToFill: number
  sampleSize: number
}

/** Campaigns a fill model may learn from: ones that actually ran to completion. */
const LEARNABLE_STATES = ['RECONCILING', 'CLOSED'] as const

/**
 * Measures claim and completion rates from campaigns that have finished.
 *
 * Returns null when there is not enough history — one campaign is a data point, not a
 * distribution, but docs/09 explicitly wants campaign 1 to replace the heuristic, so
 * the threshold is 1 and the sample size is surfaced rather than hidden.
 */
export async function measureHistoricalRates(): Promise<HistoricalRates | null> {
  const campaigns = await prisma.campaign.findMany({
    where: { state: { in: [...LEARNABLE_STATES] }, deletedAt: null },
    select: {
      id: true,
      liveAt: true,
      cities: true,
      ageBrackets: true,
      minFollowers: true,
      maxFollowers: true,
      placements: {
        select: { state: true, userId: true, claimedAt: true, settledAt: true },
      },
    },
    take: 50,
  })

  if (campaigns.length === 0) return null

  const claimRates: number[] = []
  const completionRates: number[] = []
  const daysToFill: number[] = []

  for (const campaign of campaigns) {
    if (campaign.placements.length === 0) continue

    // The eligible population as it stands now. This drifts from what it was during the
    // campaign, which is a known limitation — it is still a far better basis than
    // assuming a 100% claim rate.
    const eligible = await countEligibleAccounts({
      cities: campaign.cities,
      ageBrackets: campaign.ageBrackets,
      minFollowers: campaign.minFollowers,
      maxFollowers: campaign.maxFollowers,
    })

    const claimers = new Set(campaign.placements.map((p) => p.userId)).size
    if (eligible > 0) claimRates.push(Math.min(1, claimers / eligible))

    const paid = campaign.placements.filter((p) => p.state === 'PAID').length
    completionRates.push(paid / campaign.placements.length)

    const settled = campaign.placements
      .map((p) => p.settledAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())

    if (campaign.liveAt && settled[0]) {
      const days = (settled[0].getTime() - campaign.liveAt.getTime()) / (24 * 60 * 60 * 1000)
      if (days > 0) daysToFill.push(days)
    }
  }

  if (claimRates.length === 0) return null

  return {
    claimRate: median(claimRates),
    completionRate: completionRates.length > 0 ? median(completionRates) : 0.8,
    medianDaysToFill: daysToFill.length > 0 ? median(daysToFill) : 7,
    sampleSize: claimRates.length,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!
}

export async function countEligibleAccounts(audience: {
  cities: string[]
  ageBrackets: string[]
  minFollowers: number
  maxFollowers?: number | null
}): Promise<number> {
  return prisma.socialAccount.count({
    where: {
      deletedAt: null,
      tier: { in: ['CONNECTED_API', 'CONNECTED_SCREENSHOT'] },
      followers: {
        gte: audience.minFollowers,
        ...(audience.maxFollowers ? { lte: audience.maxFollowers } : {}),
      },
      user: {
        deletedAt: null,
        state: { in: ['VERIFIED', 'ACTIVE'] },
        ...(audience.cities.length > 0 ? { city: { in: audience.cities } } : {}),
        ...(audience.ageBrackets.length > 0 ? { ageBracket: { in: audience.ageBrackets } } : {}),
      },
    },
  })
}

/**
 * The number the campaign builder shows: "expected fill ~X% in Y days".
 *
 * With history, it is `min(budget capacity, eligible x claim rate)` — that is, the
 * forecast is capped by whichever runs out first, money or willing participants.
 * Without history it falls back to the pure budget-capacity heuristic.
 */
export async function estimateFill(args: {
  template: Template
  budgetOre: number
  perPlacementMaxOre: number
  medianAvgViews: number
  eligibleAccounts: number
  rates?: HistoricalRates | null
}): Promise<FillEstimate> {
  const perPlacement = reservationOre(
    args.template,
    { avgViews30d: args.medianAvgViews || 450 },
    args.perPlacementMaxOre,
  )

  const placementsAffordable = perPlacement > 0 ? Math.floor(args.budgetOre / perPlacement) : 0
  const rates = args.rates === undefined ? await measureHistoricalRates() : args.rates

  if (!rates) {
    // Heuristic: what share of the eligible population the budget could cover if every
    // one of them claimed. Honest as an upper bound, labelled as such.
    const percent =
      args.eligibleAccounts > 0
        ? Math.min(100, Math.round((placementsAffordable / args.eligibleAccounts) * 100))
        : 0
    return {
      percent,
      days: placementsAffordable > 0 ? Math.max(1, Math.ceil(placementsAffordable / 25)) : 0,
      placementsAffordable,
      eligibleAccounts: args.eligibleAccounts,
      basis: 'heuristic',
      sampleSize: 0,
    }
  }

  // With history: how many will actually claim, and how many of those will complete.
  const expectedClaims = Math.floor(args.eligibleAccounts * rates.claimRate)
  const expectedCompleted = Math.floor(Math.min(expectedClaims, placementsAffordable) * rates.completionRate)

  const percent =
    placementsAffordable > 0
      ? Math.min(100, Math.round((expectedCompleted / placementsAffordable) * 100))
      : 0

  // If demand outruns the budget, the campaign fills faster than the historical median.
  const demandRatio = placementsAffordable > 0 ? expectedClaims / placementsAffordable : 0
  const days =
    demandRatio >= 1
      ? Math.max(1, Math.round(rates.medianDaysToFill / Math.max(1, demandRatio)))
      : Math.round(rates.medianDaysToFill)

  return {
    percent,
    days,
    placementsAffordable,
    eligibleAccounts: args.eligibleAccounts,
    basis: 'model',
    sampleSize: rates.sampleSize,
  }
}
