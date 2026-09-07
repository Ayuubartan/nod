/**
 * Verification pipeline — docs/03 section 1, "Verification order (P-09) — stop at first fail".
 *
 *   1. Account matches the SocialAccount of the claim
 *   2. Disclosure present in the caption (+ Paid Partnership label where available)
 *   3. Published media matches the approved media (perceptual hash)
 *   4. Views: API pull, or ops-entered from a screenshot
 *   5. Fraud score
 *   6. qualified_views = views x geo x (1 - fraud_discount)
 *
 * CLAUDE.md rule 5: check 2 is a payable condition. A placement without disclosure is
 * REJECTED, never QUALIFIED, and there is no ops override — `runChecks` has no
 * parameter that can skip it, by design.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { assessFraud, type FraudAssessment } from '@/lib/fraud'
import {
  assessFraudV1,
  collectCrossCampaignSignals,
  crossCampaignSignalsAreMeaningful,
  geoMatchFrom,
} from '@/lib/fraud-v1'
import { disclosurePresent, similarity } from '@/lib/media'
import { qualifiedViews as computeQualified } from '@/lib/money/calc'
import { LIMITS } from '@/lib/money/rates'
import { flagForOps, qualify, reject } from './placement'
import { SYSTEM, type ActorRef } from './transition'

export type CheckName = 'account' | 'disclosure' | 'media' | 'views' | 'fraud'

export type VerificationInput = {
  placementId: string
  /** The account the post was actually found on. */
  observedPlatformUserId: string | null
  caption: string | null
  hasPaidPartnershipLabel: boolean | null
  /** Perceptual hash of the published media, when NOD could fetch it. */
  publishedHash: string | null
  views: number | null
  viewsSource: 'api' | 'screenshot'
  engagements?: number | null
  accountAgeDays?: number
  geoMatch?: number | null
  /** Raw audience-by-country from the platform API, when the account exposes it (M5). */
  audienceByCountry?: Record<string, number> | null
  /** True when the post is still live — decides whether a fix window is offered. */
  stillLive?: boolean
}

export type VerificationOutcome =
  | { decision: 'QUALIFIED'; qualifiedViews: number; toUserOre: number }
  | { decision: 'REJECTED'; failedCheck: CheckName; reason: string; fixWindow: boolean }
  | { decision: 'FLAGGED'; assessment: FraudAssessment }
  | { decision: 'NEEDS_OPS'; reason: string }

/**
 * Runs the checks in order and applies the outcome. Writes the Verification row with
 * every check's result, so ops and a disputing brand can see exactly what happened
 * (docs/03 edge case 8: ops reviews checks 2 and 3 only).
 */
export async function verify(
  input: VerificationInput,
  actor: ActorRef = SYSTEM,
  now: Date = new Date(),
): Promise<VerificationOutcome> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: input.placementId },
    include: {
      account: true,
      campaign: { include: { payoutTemplate: true } },
      user: { select: { id: true, createdAt: true } },
    },
  })

  const record = async (data: Prisma.VerificationUncheckedUpdateInput & Prisma.VerificationUncheckedCreateInput) => {
    await prisma.verification.upsert({
      where: { placementId: input.placementId },
      create: data,
      update: data,
    })
  }

  const base = {
    placementId: input.placementId,
    viewsSource: input.viewsSource,
    decidedBy: actor.id ? `ops:${actor.id}` : 'system',
    decidedAt: now,
  }

  // --- check 1: account matches the SocialAccount of the claim
  const accountMatch =
    input.observedPlatformUserId === null || input.observedPlatformUserId === placement.account.platformUserId

  if (!accountMatch) {
    await record({ ...base, accountMatch: false })
    await reject(
      { placementId: input.placementId, reason: 'WRONG_ACCOUNT', strike: 'SERIOUS' },
      actor,
      now,
    )
    return { decision: 'REJECTED', failedCheck: 'account', reason: 'WRONG_ACCOUNT', fixWindow: false }
  }

  // --- check 2: disclosure. The payable condition. No override exists.
  const requiredText = placement.disclosureTextIssued ?? placement.campaign.disclosureText
  const disclosureOk = disclosurePresent(input.caption, requiredText)
  const labelOk = input.hasPaidPartnershipLabel

  if (!disclosureOk) {
    await record({ ...base, accountMatch: true, disclosureOk: false, labelOk })

    // 12-hour fix window only if the post is still live and we are still inside the
    // hold, and only once — `attempt` on the Verification row is the counter.
    const existing = await prisma.verification.findUnique({
      where: { placementId: input.placementId },
      select: { attempt: true },
    })
    const firstAttempt = (existing?.attempt ?? 1) <= 1
    const withinHold = placement.holdEndsAt ? now < placement.holdEndsAt : false
    const fixWindow = Boolean(input.stillLive) && withinHold && firstAttempt

    await reject(
      {
        placementId: input.placementId,
        reason: 'NO_DISCLOSURE',
        strike: 'MINOR',
        fixWindow,
      },
      actor,
      now,
    )
    return { decision: 'REJECTED', failedCheck: 'disclosure', reason: 'NO_DISCLOSURE', fixWindow }
  }

  // --- check 3: published media matches what was approved
  let mediaMatch: number | null = null
  if (input.publishedHash && placement.originalHash) {
    mediaMatch = similarity(input.publishedHash, placement.originalHash)
    if (mediaMatch < LIMITS.mediaMatchThreshold) {
      await record({ ...base, accountMatch: true, disclosureOk: true, labelOk, mediaMatch })
      await reject(
        { placementId: input.placementId, reason: 'MEDIA_MISMATCH', strike: 'SERIOUS' },
        actor,
        now,
      )
      return { decision: 'REJECTED', failedCheck: 'media', reason: 'MEDIA_MISMATCH', fixWindow: false }
    }
  }

  // --- check 4: views. Screenshot-tier placements wait for ops to enter the number.
  if (input.views === null) {
    await record({ ...base, accountMatch: true, disclosureOk: true, labelOk, mediaMatch })
    return { decision: 'NEEDS_OPS', reason: 'Views must be entered from the screenshot' }
  }

  await prisma.viewSnapshot.create({
    data: {
      verification: {
        connectOrCreate: {
          where: { placementId: input.placementId },
          create: { ...base, accountMatch: true, disclosureOk: true, labelOk, mediaMatch },
        },
      },
      views: input.views,
      source: input.viewsSource,
      at: now,
    },
  })

  // --- check 5: fraud
  const [priorQualified, priorFraudRejects] = await Promise.all([
    prisma.placement.count({
      where: { userId: placement.userId, state: { in: ['QUALIFIED', 'PAID'] }, id: { not: input.placementId } },
    }),
    prisma.placement.count({
      where: { userId: placement.userId, state: 'REJECTED', rejectReason: 'FRAUD' },
    }),
  ])

  const accountAgeDays =
    input.accountAgeDays ??
    Math.floor((now.getTime() - placement.account.createdAt.getTime()) / (24 * 60 * 60 * 1000))

  // Geo comes from the API where the account exposes it; an explicit geoMatch wins, and
  // an account whose audience NOD cannot see is never penalised for it.
  const geoMatch =
    input.geoMatch ?? geoMatchFrom(input.audienceByCountry, placement.campaign.countries)

  const baseInput = {
    views: input.views,
    avgViews30d: placement.account.avgViews30d,
    followers: placement.account.followers,
    accountAgeDays,
    engagements: input.engagements ?? null,
    priorQualified,
    priorFraudRejects,
    geoMatch,
  }

  // v1 adds cross-campaign pattern detection, but only once the campaign has enough
  // decided placements for a "cluster" to be distinguishable from coincidence. Below
  // that it would just add noise to an ops queue with a 48h SLA (docs/09 M5 task 4).
  const assessment = (await crossCampaignSignalsAreMeaningful(placement.campaignId))
    ? assessFraudV1(
        baseInput,
        await collectCrossCampaignSignals({
          placementId: input.placementId,
          campaignId: placement.campaignId,
          userId: placement.userId,
          views: input.views,
          decidedAt: now,
        }),
      )
    : assessFraud(baseInput)

  // --- check 6: qualified views
  const qualified = computeQualified(input.views, assessment.geoFactor, assessment.fraudDiscount)

  await record({
    ...base,
    accountMatch: true,
    disclosureOk: true,
    labelOk,
    mediaMatch,
    views: input.views,
    fraudScore: assessment.score,
    fraudFactors: assessment.factors as unknown as Prisma.InputJsonValue,
    geoFactor: assessment.geoFactor,
    qualifiedViews: qualified,
  })

  if (assessment.flagged) {
    await flagForOps(input.placementId, `Fraud score ${assessment.score}`, actor)
    return { decision: 'FLAGGED', assessment }
  }

  const { toUserOre } = await qualify(input.placementId, qualified, actor)
  return { decision: 'QUALIFIED', qualifiedViews: qualified, toUserOre }
}

/**
 * Ops clears a flagged placement — docs/03 edge case 2: "if cleared, paid at
 * reservation cap". The settle function already caps at the reservation, so clearing
 * just qualifies at the recorded number.
 */
export async function clearFlagAndQualify(placementId: string, actor: ActorRef): Promise<number> {
  const verification = await prisma.verification.findUniqueOrThrow({
    where: { placementId },
    select: { qualifiedViews: true, views: true },
  })
  const views = verification.qualifiedViews ?? verification.views ?? 0
  const { toUserOre } = await qualify(placementId, views, actor)
  return toUserOre
}

/** Ops confirms fraud on a flagged placement. */
export async function confirmFraud(placementId: string, note: string, actor: ActorRef): Promise<void> {
  await reject({ placementId, reason: 'FRAUD', note, strike: 'SERIOUS' }, actor)
}

/**
 * Mid-hold re-check for posts and reels — docs/03 P-08 "midpoint re-check for posts",
 * and edge case 5: a Story deleted at 6 hours fails the re-check and is rejected with a
 * serious strike.
 */
export async function holdRecheck(
  placementId: string,
  stillLive: boolean,
  actor: ActorRef = SYSTEM,
): Promise<'ok' | 'rejected'> {
  if (stillLive) return 'ok'
  await reject({ placementId, reason: 'DELETED_EARLY', strike: 'SERIOUS' }, actor)
  return 'rejected'
}
