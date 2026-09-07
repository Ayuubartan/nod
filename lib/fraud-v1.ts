/**
 * Fraud score v1 — docs/09 M5 task 4: "cross-campaign patterns; geo from API where
 * available".
 *
 * v0 (lib/fraud.ts) scores one placement against one account's own history. It cannot
 * see the shapes that only appear across a population:
 *
 *   - a cluster of accounts that all spike on the same campaign at the same hour
 *   - an account whose numbers are normal alone but identical to several others
 *   - a participant whose every placement lands just under the flag threshold
 *   - view counts that repeat suspiciously exactly across placements
 *
 * v1 adds those as additional factors on top of v0's score, so a placement that v0
 * already flags is never un-flagged by v1 — the two compose, they do not compete.
 *
 * Everything here stays explainable: ops has a 48-hour SLA and has to be able to say
 * why money was withheld.
 */

import { prisma } from './db'
import { assessFraud, type FraudAssessment, type FraudFactor, type FraudInput } from './fraud'
import { LIMITS } from './money/rates'

export type CrossCampaignSignals = {
  /** Other placements on the same campaign that settled within the same hour. */
  simultaneousSpikes: number
  /** How many other placements reported exactly this view count on this campaign. */
  identicalViewCounts: number
  /** This participant's placements that landed within 5% below the flag threshold. */
  nearMissCount: number
  /** Share of this participant's placements that were rejected for any reason, 0..1. */
  historicalRejectRate: number
  /** Distinct accounts this participant has claimed with on this campaign. */
  accountsUsedOnCampaign: number
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/**
 * How much weight population evidence carries relative to the account's own numbers.
 * See the worked calibration in `assessFraudV1`. It is a constant rather than a Flag
 * because changing it changes who gets paid, and that should be a reviewed commit.
 */
const LIFT_SCALE = 0.75

/**
 * Gathers the population-level signals. Deliberately a separate function from the
 * scoring so it can be unit-tested against fixtures and so the scoring stays pure.
 */
export async function collectCrossCampaignSignals(args: {
  placementId: string
  campaignId: string
  userId: string
  views: number
  decidedAt?: Date
}): Promise<CrossCampaignSignals> {
  const at = args.decidedAt ?? new Date()
  const hourStart = new Date(at.getTime() - 60 * 60 * 1000)

  const [sameHour, identical, participantPlacements] = await Promise.all([
    // Other placements on this campaign that were verified in the last hour with an
    // unusually high multiple of their own baseline. A coordinated ring shows up here.
    prisma.verification.count({
      where: {
        placementId: { not: args.placementId },
        decidedAt: { gte: hourStart, lte: at },
        placement: { campaignId: args.campaignId },
        fraudScore: { gte: 0.4 },
      },
    }),

    // Bought views often arrive in round, repeated amounts.
    args.views > 0
      ? prisma.verification.count({
          where: {
            placementId: { not: args.placementId },
            views: args.views,
            placement: { campaignId: args.campaignId },
          },
        })
      : Promise.resolve(0),

    prisma.placement.findMany({
      where: { userId: args.userId, deletedAt: null, id: { not: args.placementId } },
      select: {
        state: true,
        campaignId: true,
        socialAccountId: true,
        verification: { select: { fraudScore: true } },
      },
    }),
  ])

  const scored = participantPlacements.filter((p) => p.verification?.fraudScore != null)

  // Someone probing the threshold lands just under it repeatedly.
  const nearMissBand = LIMITS.fraudFlagThreshold * 0.95
  const nearMissCount = scored.filter(
    (p) => p.verification!.fraudScore! >= nearMissBand && p.verification!.fraudScore! < LIMITS.fraudFlagThreshold,
  ).length

  const terminal = participantPlacements.filter((p) =>
    ['PAID', 'REJECTED', 'REJECTED_BY_BRAND'].includes(p.state),
  )
  const rejected = terminal.filter((p) => p.state !== 'PAID').length

  const accountsUsedOnCampaign = new Set(
    participantPlacements.filter((p) => p.campaignId === args.campaignId).map((p) => p.socialAccountId),
  ).size

  return {
    simultaneousSpikes: sameHour,
    identicalViewCounts: identical,
    nearMissCount,
    historicalRejectRate: terminal.length > 0 ? rejected / terminal.length : 0,
    accountsUsedOnCampaign,
  }
}

/**
 * Combines the v0 score with the cross-campaign signals.
 *
 * The v1 score is `max(v0, v0 + weighted cross-campaign lift)`, capped at 1 — so v1 can
 * only ever raise suspicion, never lower it. A clean population history does not excuse
 * a placement that already looks wrong on its own numbers.
 */
export function assessFraudV1(base: FraudInput, signals: CrossCampaignSignals): FraudAssessment {
  const v0 = assessFraud(base)
  const extra: FraudFactor[] = []

  // 1. Coordinated timing. One other flagged placement in the same hour is noise on a
  //    busy campaign; four or more is a pattern.
  const clusterScore = signals.simultaneousSpikes <= 1 ? 0 : clamp01((signals.simultaneousSpikes - 1) / 4)
  extra.push({
    name: 'cluster_timing',
    score: clusterScore,
    weight: 0.35,
    detail: `${signals.simultaneousSpikes} other elevated placements verified within the hour`,
  })

  // 2. Identical view counts. Organic reach is never exactly equal across accounts.
  const identicalScore = signals.identicalViewCounts === 0 ? 0 : clamp01(signals.identicalViewCounts / 3)
  extra.push({
    name: 'identical_views',
    score: identicalScore,
    weight: 0.25,
    detail: `${signals.identicalViewCounts} other placements reported exactly ${base.views.toLocaleString('sv-SE')} views`,
  })

  // 3. Threshold probing.
  const nearMissScore = signals.nearMissCount === 0 ? 0 : clamp01(signals.nearMissCount / 3)
  extra.push({
    name: 'threshold_probing',
    score: nearMissScore,
    weight: 0.2,
    detail: `${signals.nearMissCount} prior placements scored just under the flag threshold`,
  })

  // 4. Rejection history across campaigns.
  const rejectScore = clamp01((signals.historicalRejectRate - 0.2) / 0.6)
  extra.push({
    name: 'reject_rate',
    score: rejectScore,
    weight: 0.2,
    detail: `${Math.round(signals.historicalRejectRate * 100)}% of prior placements were rejected`,
  })

  const lift = extra.reduce((total, factor) => total + factor.score * factor.weight, 0)

  // Calibration. The weights above sum to 1.0, so `lift` is 0..1 and LIFT_SCALE decides
  // how much population evidence it takes to flag an account whose own numbers are
  // clean (v0 = 0). Against the 0.6 flag threshold:
  //
  //   one co-occurrence, nothing else          lift 0.00 -> 0.00   not flagged
  //   3 spikes, 2 identical, 1 near-miss, 40%  lift 0.48 -> 0.36   not flagged
  //   6 spikes, 4 identical, 2 near-miss, 50%  lift 0.83 -> 0.62   FLAGGED
  //
  // So a single coincidence is ignored, a partial pattern goes to the brand as normal,
  // and only several agreeing signals hold up a payout for a human to look at.
  const score = clamp01(Math.max(v0.score, v0.score + lift * LIFT_SCALE))

  const fraudDiscount = score < 0.8 ? 0 : clamp01((score - 0.8) / 0.2) * 0.5

  return {
    score: Number(score.toFixed(4)),
    flagged: score >= LIMITS.fraudFlagThreshold,
    factors: [...v0.factors, ...extra],
    fraudDiscount,
    geoFactor: v0.geoFactor,
  }
}

/**
 * Geo from the API where available — docs/09 M5 task 4.
 *
 * Instagram exposes audience country breakdown on some insight metrics for professional
 * accounts. When present, `geoMatchFrom` turns it into the 0..1 factor that scales
 * qualified views (docs/03 check 6). When absent it returns null, which means "no
 * adjustment" rather than "penalise" — an account whose audience NOD cannot see must
 * not be paid less for it.
 */
export function geoMatchFrom(
  audienceByCountry: Record<string, number> | null | undefined,
  targetCountries: string[],
): number | null {
  if (!audienceByCountry) return null

  const total = Object.values(audienceByCountry).reduce((sum, n) => sum + n, 0)
  if (total <= 0) return null

  const targets = targetCountries.map((c) => c.toUpperCase())
  const matched = Object.entries(audienceByCountry)
    .filter(([country]) => targets.includes(country.toUpperCase()))
    .reduce((sum, [, n]) => sum + n, 0)

  return clamp01(matched / total)
}

/** True once there is enough history for the cross-campaign signals to mean anything. */
export async function crossCampaignSignalsAreMeaningful(campaignId: string): Promise<boolean> {
  const decided = await prisma.verification.count({
    where: { placement: { campaignId }, decidedAt: { not: null } },
  })
  // Under ~20 decided placements the population is too small for a cluster to be
  // distinguishable from coincidence.
  return decided >= 20
}
