/**
 * Fraud score v0 — docs/03 verification check 5, docs/09 M3 task 3.
 *
 * Factors: velocity vs the account's own 30-day baseline, account age, engagement
 * ratio, cross-campaign pattern, and a geo stub. Deliberately simple and explainable:
 * ops has to be able to read the breakdown and make a call in a 48-hour SLA, and a
 * score that cannot be explained cannot be defended to a participant whose money it
 * withholds.
 *
 * Output is 0..1. At or above LIMITS.fraudFlagThreshold the placement is FLAGGED, which
 * pauses payment but never rejects on its own — a human decides (docs/02 C).
 */

import { LIMITS } from './money/rates'

export type FraudInput = {
  /** Views reported for this placement. */
  views: number
  /** The account's own 30-day average — the baseline this is measured against. */
  avgViews30d: number
  followers: number
  /** How long the account has existed, in days. */
  accountAgeDays: number
  /** Likes + comments on the post, when the platform exposes them. */
  engagements?: number | null
  /** Placements this participant has had qualified before. */
  priorQualified: number
  /** Placements this participant has had rejected for fraud before. */
  priorFraudRejects: number
  /** Share of viewers in the campaign's target country, 0..1. Null when unknown. */
  geoMatch?: number | null
}

export type FraudFactor = { name: string; score: number; weight: number; detail: string }

export type FraudAssessment = {
  score: number
  flagged: boolean
  factors: FraudFactor[]
  /** Applied to views before payout — docs/03 check 6. */
  fraudDiscount: number
  geoFactor: number
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export function assessFraud(input: FraudInput): FraudAssessment {
  const factors: FraudFactor[] = []

  // 1. Velocity. A post doing far more than the account's own baseline is the single
  //    strongest signal, but it is also what a genuinely good post looks like — so it
  //    flags for review rather than rejecting (edge case 2).
  const baseline = Math.max(input.avgViews30d, 1)
  const ratio = input.views / baseline
  const velocityScore = ratio <= 3 ? 0 : clamp01((ratio - 3) / 12)
  factors.push({
    name: 'velocity',
    score: velocityScore,
    weight: 0.4,
    detail: `${input.views} views vs a ${input.avgViews30d} baseline (${ratio.toFixed(1)}x)`,
  })

  // 2. Views far above follower count. Plausible for a Reel, suspicious for a Story.
  const followerRatio = input.followers > 0 ? input.views / input.followers : 0
  const reachScore = followerRatio <= 2 ? 0 : clamp01((followerRatio - 2) / 8)
  factors.push({
    name: 'reach_vs_followers',
    score: reachScore,
    weight: 0.15,
    detail: `${followerRatio.toFixed(1)} views per follower`,
  })

  // 3. Account age. A brand new account with high numbers is the classic bought-views shape.
  const ageScore = input.accountAgeDays >= 180 ? 0 : clamp01((180 - input.accountAgeDays) / 180)
  factors.push({
    name: 'account_age',
    score: ageScore,
    weight: 0.15,
    detail: `${input.accountAgeDays} days old`,
  })

  // 4. Engagement ratio. Bought views arrive without likes or comments.
  let engagementScore = 0
  let engagementDetail = 'not available'
  if (input.engagements != null && input.views > 200) {
    const rate = input.engagements / input.views
    engagementScore = rate >= 0.01 ? 0 : clamp01((0.01 - rate) / 0.01)
    engagementDetail = `${(rate * 100).toFixed(2)}% engagement`
  }
  factors.push({ name: 'engagement', score: engagementScore, weight: 0.15, detail: engagementDetail })

  // 5. Cross-campaign history. A clean record earns the benefit of the doubt; a prior
  //    confirmed fraud rejection does not.
  const historyScore =
    input.priorFraudRejects > 0 ? 1 : input.priorQualified >= 3 ? 0 : input.priorQualified === 0 ? 0.3 : 0.1
  factors.push({
    name: 'history',
    score: historyScore,
    weight: 0.15,
    detail: `${input.priorQualified} qualified, ${input.priorFraudRejects} fraud rejections`,
  })

  const score = clamp01(factors.reduce((total, f) => total + f.score * f.weight, 0))

  // Geo is a stub until the API exposes audience country (docs/09 M3 task 3): unknown
  // geo means no discount, never a penalty.
  const geoFactor = input.geoMatch == null ? 1 : clamp01(input.geoMatch)

  // The discount only bites well above the flag threshold, so an ops-cleared placement
  // at 0.6 still pays in full.
  const fraudDiscount = score < 0.8 ? 0 : clamp01((score - 0.8) / 0.2) * 0.5

  return {
    score: Number(score.toFixed(4)),
    flagged: score >= LIMITS.fraudFlagThreshold,
    factors,
    fraudDiscount,
    geoFactor,
  }
}
