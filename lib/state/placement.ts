/**
 * Placement lifecycle — docs/03 section 1, steps P-01 to P-10. The core unit.
 *
 * One Placement = one Participant + one SocialAccount + one Campaign + one piece of
 * content. Every timed state sets `deadlineAt`, and every one of those has a matching
 * Inngest job in inngest/timeouts/ (CLAUDE.md rule 4).
 *
 * Every terminal non-paid state releases the reservation (docs/03) — that guarantee is
 * implemented once, in `releaseIfHeld`, and used by every path that can end a placement.
 */

import type { PlacementState, Prisma, RejectReason } from '@prisma/client'
import { prisma } from '@/lib/db'
import { randomToken } from '@/lib/crypto'
import { campaignBalance } from '@/lib/money/balances'
import { releaseReservation, reserve, settlePlacement } from '@/lib/money/ledger'
import { reservationOre as computeReservation, settle as computeSettle } from '@/lib/money/calc'
import { HOLD_MS, LIMITS, TIMEOUT_MS } from '@/lib/money/rates'
import {
  GuardError,
  runTransition,
  SYSTEM,
  type ActorRef,
  type TransitionTable,
  type Tx,
} from './transition'
import { exhaust, isClaimable, markFilling } from './campaign'
import { activateIfFirstApproval, addStrike } from './participant'

export type PlacementEvent =
  | 'UPLOAD'
  | 'POSITION'
  | 'START_GENERATION'
  | 'GENERATION_DONE'
  | 'GENERATION_FAIL'
  | 'RETRY_GENERATION'
  | 'PARTICIPANT_APPROVE'
  | 'REGENERATE'
  | 'PARTICIPANT_REJECT'
  | 'BRAND_APPROVE'
  | 'BRAND_REJECT_BOUNCE'
  | 'BRAND_REJECT_FINAL'
  | 'PUBLISH'
  | 'HOLD_END'
  | 'QUALIFY'
  | 'PAY'
  | 'REJECT'
  | 'FLAG'
  | 'UNFLAG_QUALIFY'
  | 'EXPIRE'
  | 'DISPUTE'
  | 'RESOLVE_DISPUTE'

/**
 * The transition table is the spec (docs/03 P-01..P-10).
 *
 * Two rows worth calling out:
 *  - PARTICIPANT_REVIEW -> POSITIONED on REGENERATE: a regeneration re-enters the
 *    positioning step so the participant can move the region, capped at 3 (docs/03 P-05).
 *  - BRAND_REVIEW -> POSITIONED on BRAND_REJECT_BOUNCE, once; after that a brand
 *    rejection is final and releases the reservation (docs/03 P-06).
 */
export const PLACEMENT_TABLE: TransitionTable<PlacementState, PlacementEvent> = {
  CLAIMED: { UPLOAD: 'UPLOADED', EXPIRE: 'EXPIRED', PARTICIPANT_REJECT: 'REJECTED_BY_PARTICIPANT' },
  UPLOADED: { POSITION: 'POSITIONED', EXPIRE: 'EXPIRED', PARTICIPANT_REJECT: 'REJECTED_BY_PARTICIPANT' },
  POSITIONED: {
    START_GENERATION: 'GENERATING',
    EXPIRE: 'EXPIRED',
    PARTICIPANT_REJECT: 'REJECTED_BY_PARTICIPANT',
  },
  GENERATING: {
    GENERATION_DONE: 'PARTICIPANT_REVIEW',
    GENERATION_FAIL: 'GENERATION_FAILED',
    EXPIRE: 'EXPIRED',
  },
  GENERATION_FAILED: { RETRY_GENERATION: 'GENERATING', EXPIRE: 'EXPIRED' },
  PARTICIPANT_REVIEW: {
    PARTICIPANT_APPROVE: 'BRAND_REVIEW',
    REGENERATE: 'POSITIONED',
    PARTICIPANT_REJECT: 'REJECTED_BY_PARTICIPANT',
    EXPIRE: 'EXPIRED',
  },
  BRAND_REVIEW: {
    BRAND_APPROVE: 'APPROVED',
    BRAND_REJECT_BOUNCE: 'POSITIONED',
    BRAND_REJECT_FINAL: 'REJECTED_BY_BRAND',
    EXPIRE: 'EXPIRED',
  },
  APPROVED: { PUBLISH: 'PUBLISHED', EXPIRE: 'EXPIRED' },
  PUBLISHED: { HOLD_END: 'VERIFYING', REJECT: 'REJECTED' },
  VERIFYING: { QUALIFY: 'QUALIFIED', REJECT: 'REJECTED', FLAG: 'FLAGGED' },
  FLAGGED: { UNFLAG_QUALIFY: 'QUALIFIED', REJECT: 'REJECTED' },
  QUALIFIED: { PAY: 'PAID' },
  PAID: { DISPUTE: 'DISPUTED' },
  DISPUTED: { RESOLVE_DISPUTE: 'PAID' },
  REJECTED: {},
  EXPIRED: {},
  REJECTED_BY_PARTICIPANT: {},
  REJECTED_BY_BRAND: {},
}

/** Terminal non-paid states: all of these must release the reservation (docs/03). */
export const RELEASING_STATES: PlacementState[] = [
  'REJECTED',
  'EXPIRED',
  'REJECTED_BY_PARTICIPANT',
  'REJECTED_BY_BRAND',
]

export const TERMINAL_STATES: PlacementState[] = [...RELEASING_STATES, 'PAID']

/** States that still hold budget — used to decide whether to release on a transition. */
const HOLDS_RESERVATION: PlacementState[] = [
  'CLAIMED',
  'UPLOADED',
  'POSITIONED',
  'GENERATING',
  'GENERATION_FAILED',
  'PARTICIPANT_REVIEW',
  'BRAND_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'VERIFYING',
  'FLAGGED',
]

const load = (placementId: string) => async (tx: Tx) =>
  tx.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: {
      id: true,
      state: true,
      campaignId: true,
      userId: true,
      socialAccountId: true,
      reservationOre: true,
      regenCount: true,
      deadlineAt: true,
      clockPausedAt: true,
      pausedMs: true,
      contentType: true,
      originalHash: true,
      publishedAt: true,
      holdEndsAt: true,
      disclosureToken: true,
      currentVersionId: true,
    },
  })

/**
 * Release a reservation exactly once. Safe to call from any terminal path: it checks
 * the ledger rather than the placement state, so a double call cannot double-release.
 */
async function releaseIfHeld(tx: Tx, placementId: string, memo: string): Promise<number> {
  const placement = await tx.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { campaignId: true, reservationOre: true },
  })

  const entries = await tx.ledgerEntry.findMany({
    where: { placementId, type: { in: ['RESERVE', 'RELEASE_RESERVATION', 'SETTLE'] } },
    select: { type: true, amountOre: true },
  })

  const reserved = entries.filter((e) => e.type === 'RESERVE').reduce((s, e) => s + e.amountOre, 0)
  const released = entries.filter((e) => e.type === 'RELEASE_RESERVATION').reduce((s, e) => s + e.amountOre, 0)
  const settled = entries.filter((e) => e.type === 'SETTLE').reduce((s, e) => s + e.amountOre, 0)

  const outstanding = reserved - released - settled
  if (outstanding <= 0) return 0

  await releaseReservation(tx, placement.campaignId, placementId, outstanding, memo)
  return outstanding
}

// ---------------------------------------------------------------- P-01 claim

export class ClaimError extends GuardError {}

export type ClaimInput = {
  campaignId: string
  userId: string
  socialAccountId: string
  contentType?: 'story' | 'reel' | 'post'
}

/**
 * P-01 CLAIMED. The only place a reservation is created.
 *
 * "A claim that cannot reserve its expected payout fails" (CLAUDE.md rule 3), so the
 * budget check and the RESERVE entry happen in the same transaction as the insert.
 * The 48-hour clock starts here and is shared by P-02 and P-03.
 */
export async function claim(input: ClaimInput, now: Date = new Date()): Promise<{ id: string; reservationOre: number }> {
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({
      where: { id: input.campaignId },
      include: { payoutTemplate: true },
    })
    if (!isClaimable(campaign.state)) {
      throw new ClaimError('CAMPAIGN_NOT_CLAIMABLE', `Campaign is ${campaign.state}`)
    }
    if (!campaign.payoutTemplate) throw new ClaimError('NO_TEMPLATE', 'Campaign has no payout template')
    if (campaign.endsAt && campaign.endsAt <= now) throw new ClaimError('CAMPAIGN_ENDED', 'Campaign has ended')

    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { state: true, city: true, ageBracket: true },
    })
    if (user.state !== 'VERIFIED' && user.state !== 'ACTIVE') {
      throw new ClaimError('NOT_ELIGIBLE', `Participant is ${user.state}`)
    }

    const account = await tx.socialAccount.findUniqueOrThrow({
      where: { id: input.socialAccountId },
      select: { id: true, userId: true, tier: true, followers: true, avgViews30d: true, categories: true, deletedAt: true },
    })
    if (account.userId !== input.userId || account.deletedAt) {
      throw new ClaimError('WRONG_ACCOUNT', 'That account does not belong to this participant')
    }
    if (account.tier === 'BELOW_FLOOR' || account.tier === 'DISCONNECTED') {
      throw new ClaimError('ACCOUNT_TIER', `Account is ${account.tier}`)
    }

    // Audience filters — docs/02 B1 step 2.
    if (campaign.minFollowers > 0 && account.followers < campaign.minFollowers) {
      throw new ClaimError('FOLLOWERS', `Needs ${campaign.minFollowers} followers`)
    }
    if (campaign.maxFollowers && account.followers > campaign.maxFollowers) {
      throw new ClaimError('FOLLOWERS', 'Above the follower ceiling')
    }
    if (campaign.cities.length > 0 && (!user.city || !campaign.cities.includes(user.city))) {
      throw new ClaimError('CITY', 'Not in the campaign cities')
    }
    if (campaign.ageBrackets.length > 0 && (!user.ageBracket || !campaign.ageBrackets.includes(user.ageBracket))) {
      throw new ClaimError('AGE', 'Not in the campaign age brackets')
    }
    if (campaign.categories.length > 0 && !campaign.categories.some((c) => account.categories.includes(c))) {
      throw new ClaimError('CATEGORY', 'Account categories do not match')
    }
    if (campaign.exclusions.length > 0 && campaign.exclusions.some((c) => account.categories.includes(c))) {
      throw new ClaimError('CATEGORY', 'Account category is excluded')
    }

    // Per-person cap counts across all of that person's accounts (docs/05).
    const existing = await tx.placement.count({
      where: {
        campaignId: input.campaignId,
        userId: input.userId,
        deletedAt: null,
        state: { notIn: ['EXPIRED', 'REJECTED_BY_PARTICIPANT'] },
      },
    })
    if (existing >= campaign.perPersonCap) {
      throw new ClaimError('CAP', `Cap of ${campaign.perPersonCap} placements reached`)
    }

    const reservationOre = computeReservation(campaign.payoutTemplate, account, campaign.perPlacementMax)

    const balance = await campaignBalance(tx, input.campaignId)
    if (balance.availableOre < reservationOre) {
      throw new ClaimError('BUDGET', 'Not enough budget left to reserve this placement')
    }

    const placement = await tx.placement.create({
      data: {
        campaignId: input.campaignId,
        userId: input.userId,
        socialAccountId: input.socialAccountId,
        state: 'CLAIMED',
        reservationOre,
        claimedAt: now,
        deadlineAt: new Date(now.getTime() + TIMEOUT_MS.claim),
        contentType: input.contentType ?? null,
      },
      select: { id: true },
    })

    await reserve(tx, input.campaignId, placement.id, reservationOre)

    await tx.auditLog.create({
      data: {
        entity: 'Placement',
        entityId: placement.id,
        toState: 'CLAIMED',
        event: 'CLAIM',
        actor: `participant:${input.userId}`,
        payload: { reservationOre, campaignId: input.campaignId } as Prisma.InputJsonValue,
      },
    })

    await markFilling(input.campaignId, tx)

    // If this claim used the last of the budget, stop accepting new ones (docs/03).
    const after = await campaignBalance(tx, input.campaignId)
    if (after.availableOre <= 0 && (campaign.state === 'LIVE' || campaign.state === 'FILLING')) {
      await exhaust(input.campaignId, SYSTEM, tx)
    }

    return { id: placement.id, reservationOre }
  })
}

// ---------------------------------------------------------------- P-02 upload

export type UploadInput = {
  placementId: string
  storagePath: string
  perceptualHash: string
  contentType: 'story' | 'reel' | 'post'
}

/**
 * P-02 UPLOADED. Pre-check is format/size (validated at the edge), duplicate hash and
 * brand safety. Shares the P-01 clock — `deadlineAt` is not moved.
 */
export async function upload(input: UploadInput, actor: ActorRef): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: input.placementId,
    table: PLACEMENT_TABLE,
    event: 'UPLOAD',
    actor,
    load: load(input.placementId),
    guard: async (tx) => {
      // Edge case 6: the same image cannot be claimed twice, on any campaign.
      const duplicate = await tx.placement.findFirst({
        where: {
          originalHash: input.perceptualHash,
          deletedAt: null,
          id: { not: input.placementId },
          state: { notIn: ['EXPIRED', 'REJECTED_BY_PARTICIPANT', 'REJECTED'] },
        },
        select: { id: true },
      })
      if (duplicate) throw new GuardError('DUPLICATE', 'This image is already used in a placement')
    },
    apply: async (tx) =>
      tx.placement.update({
        where: { id: input.placementId },
        data: {
          state: 'UPLOADED',
          originalPath: input.storagePath,
          originalHash: input.perceptualHash,
          contentType: input.contentType,
        },
      }),
    events: () => [{ name: 'placement/uploaded', data: { placementId: input.placementId } }],
  })
  return result.to as PlacementState
}

// ---------------------------------------------------------------- P-03 position

export type Region = { x: number; y: number; w: number; h: number; label?: string }

/** P-03 POSITIONED. Records the chosen surface and product as a training signal. */
export async function position(
  placementId: string,
  args: { region: Region; assetId: string; candidates?: Region[] },
  actor: ActorRef,
): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'POSITION',
    actor,
    load: load(placementId),
    apply: async (tx) => {
      await tx.placementEvent.create({
        data: {
          placementId,
          type: 'REGION_PICKED',
          payload: { region: args.region, assetId: args.assetId, candidates: args.candidates ?? [] } as Prisma.InputJsonValue,
        },
      })
      return tx.placement.update({
        where: { id: placementId },
        data: { state: 'POSITIONED', regionJson: args.region as unknown as Prisma.InputJsonValue, assetId: args.assetId },
      })
    },
    events: () => [{ name: 'placement/positioned', data: { placementId } }],
  })
  return result.to as PlacementState
}

// ---------------------------------------------------------------- P-04 generation

/**
 * P-04 GENERATING. The participant's clock is PAUSED here (docs/03: "clock paused"),
 * because a slow ops queue must not eat the participant's 48 hours.
 */
export async function startGeneration(placementId: string, actor: ActorRef = SYSTEM, now: Date = new Date()) {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'START_GENERATION',
    actor,
    load: load(placementId),
    apply: async (tx) =>
      tx.placement.update({ where: { id: placementId }, data: { state: 'GENERATING', clockPausedAt: now } }),
    events: () => [{ name: 'placement/generating', data: { placementId } }],
  })
  return result.to as PlacementState
}

/** Resumes a paused clock, adding the paused duration back onto the deadline. */
async function resumeClock(tx: Tx, placementId: string, now: Date, extendToMs?: number): Promise<void> {
  const placement = await tx.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { clockPausedAt: true, deadlineAt: true, pausedMs: true },
  })

  const pausedFor = placement.clockPausedAt ? now.getTime() - placement.clockPausedAt.getTime() : 0
  const deadline = extendToMs
    ? new Date(now.getTime() + extendToMs)
    : new Date(placement.deadlineAt.getTime() + pausedFor)

  await tx.placement.update({
    where: { id: placementId },
    data: { clockPausedAt: null, pausedMs: placement.pausedMs + pausedFor, deadlineAt: deadline },
  })
}

/** P-04 -> P-05. The engine produced a version; the participant now has 24 hours. */
export async function generationDone(
  placementId: string,
  version: { storagePath: string; engine: string; params?: Record<string, unknown> },
  actor: ActorRef = SYSTEM,
  now: Date = new Date(),
): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'GENERATION_DONE',
    actor,
    load: load(placementId),
    apply: async (tx) => {
      const created = await tx.placementVersion.create({
        data: {
          placementId,
          storagePath: version.storagePath,
          engine: version.engine,
          params: (version.params ?? {}) as Prisma.InputJsonValue,
        },
        select: { id: true },
      })
      await resumeClock(tx, placementId, now, TIMEOUT_MS.participantReview)
      return tx.placement.update({
        where: { id: placementId },
        data: { state: 'PARTICIPANT_REVIEW', currentVersionId: created.id },
      })
    },
    events: () => [{ name: 'placement/generated', data: { placementId } }],
  })
  return result.to as PlacementState
}

export async function generationFailed(placementId: string, reason: string, actor: ActorRef = SYSTEM) {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'GENERATION_FAIL',
    actor,
    reason,
    load: load(placementId),
    apply: async (tx) => tx.placement.update({ where: { id: placementId }, data: { state: 'GENERATION_FAILED' } }),
    events: () => [{ name: 'placement/generation.failed', data: { placementId, reason } }],
  })
  return result.to as PlacementState
}

export async function retryGeneration(placementId: string, actor: ActorRef = SYSTEM, now: Date = new Date()) {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'RETRY_GENERATION',
    actor,
    load: load(placementId),
    apply: async (tx) =>
      tx.placement.update({ where: { id: placementId }, data: { state: 'GENERATING', clockPausedAt: now } }),
    events: () => [{ name: 'placement/generating', data: { placementId, retry: true } }],
  })
  return result.to as PlacementState
}

// ---------------------------------------------------------------- P-05 participant review

/**
 * P-05 -> P-06. Tier A auto-approves with a 5% sample flag; Tier B always queues to the
 * brand (docs/03 P-06). Either way the participant's part is done here.
 */
export async function participantApprove(
  placementId: string,
  actor: ActorRef,
  options: { sampleRoll?: number; now?: Date } = {},
): Promise<{ state: PlacementState; autoApproved: boolean }> {
  const now = options.now ?? new Date()
  let autoApproved = false

  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'PARTICIPANT_APPROVE',
    actor,
    load: load(placementId),
    apply: async (tx, { entity }) => {
      await tx.placementEvent.create({
        data: { placementId, type: 'APPROVE', payload: { at: now.toISOString() } as Prisma.InputJsonValue },
      })

      const campaign = await tx.campaign.findUniqueOrThrow({
        where: { id: entity.campaignId as string },
        select: { reviewTier: true },
      })

      if (campaign.reviewTier === 'A') {
        autoApproved = true
        const roll = options.sampleRoll ?? Math.random()
        const sampled = roll < LIMITS.tierASampleRate
        if (sampled) {
          await tx.placementEvent.create({
            data: { placementId, type: 'BRAND_SAMPLE_OK', payload: { sampled: true } as Prisma.InputJsonValue },
          })
        }
        return tx.placement.update({
          where: { id: placementId },
          data: {
            state: 'BRAND_REVIEW',
            brandSampled: sampled,
            deadlineAt: new Date(now.getTime() + TIMEOUT_MS.brandReview),
          },
        })
      }

      return tx.placement.update({
        where: { id: placementId },
        data: { state: 'BRAND_REVIEW', deadlineAt: new Date(now.getTime() + TIMEOUT_MS.brandReview) },
      })
    },
    events: () => [
      { name: 'placement/participant.approved', data: { placementId } },
      { name: 'placement/brand.review', data: { placementId, autoApproved } },
    ],
  })

  // Tier A never waits on a human: approve immediately after queuing.
  if (autoApproved) {
    const state = await brandApprove(placementId, SYSTEM, now, 'Tier A auto-approval')
    return { state, autoApproved: true }
  }

  return { state: result.to as PlacementState, autoApproved: false }
}

/**
 * P-05 regenerate — max 3, counted on the placement and logged as a training signal.
 *
 * `countsTowardLimit: false` is for a brand swapping its creative mid-campaign
 * (lib/creative.ts): the participant did nothing, so it must cost them none of their
 * three regenerations. The event is still logged, tagged with who caused it.
 */
export async function regenerate(
  placementId: string,
  args: {
    reason?: string
    region?: Region
    assetId?: string
    kind?: 'REGEN' | 'MOVE' | 'SWAP'
    countsTowardLimit?: boolean
  },
  actor: ActorRef,
): Promise<PlacementState> {
  const counts = args.countsTowardLimit ?? true
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'REGENERATE',
    actor,
    reason: args.reason,
    load: load(placementId),
    guard: (_tx, placement) => {
      if (counts && (placement.regenCount as number) >= LIMITS.maxRegens) {
        throw new GuardError('REGEN_LIMIT', `Only ${LIMITS.maxRegens} regenerations are allowed`)
      }
    },
    apply: async (tx, { entity }) => {
      await tx.placementEvent.create({
        data: {
          placementId,
          type: args.kind ?? 'REGEN',
          payload: {
            reason: args.reason ?? null,
            region: args.region ?? null,
            assetId: args.assetId ?? null,
            attempt: (entity.regenCount as number) + (counts ? 1 : 0),
            by: actor.kind,
          } as Prisma.InputJsonValue,
        },
      })
      return tx.placement.update({
        where: { id: placementId },
        data: {
          state: 'POSITIONED',
          ...(counts ? { regenCount: { increment: 1 } } : {}),
          ...(args.region ? { regionJson: args.region as unknown as Prisma.InputJsonValue } : {}),
          ...(args.assetId ? { assetId: args.assetId } : {}),
        },
      })
    },
    events: () => [{ name: 'placement/positioned', data: { placementId, regenerated: true } }],
  })
  return result.to as PlacementState
}

export async function participantReject(placementId: string, reason: string, actor: ActorRef): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'PARTICIPANT_REJECT',
    actor,
    reason,
    load: load(placementId),
    apply: async (tx) => {
      await tx.placementEvent.create({
        data: { placementId, type: 'REJECT_P', payload: { reason } as Prisma.InputJsonValue },
      })
      await releaseIfHeld(tx, placementId, 'Participant rejected')
      return tx.placement.update({
        where: { id: placementId },
        data: { state: 'REJECTED_BY_PARTICIPANT', rejectNote: reason },
      })
    },
    events: () => [{ name: 'placement/rejected', data: { placementId, by: 'participant', reason } }],
  })
  return result.to as PlacementState
}

// ---------------------------------------------------------------- P-06 brand review

/**
 * P-06 -> P-07 APPROVED. Issues the disclosure text the participant must use and a
 * token that post-detection matches on. The 48-hour publish clock starts here.
 */
export async function brandApprove(
  placementId: string,
  actor: ActorRef,
  now: Date = new Date(),
  reason?: string,
): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'BRAND_APPROVE',
    actor,
    reason,
    load: load(placementId),
    apply: async (tx, { entity }) => {
      const campaign = await tx.campaign.findUniqueOrThrow({
        where: { id: entity.campaignId as string },
        select: { disclosureText: true, brand: { select: { name: true } } },
      })
      const disclosure = campaign.disclosureText.replace('{brand}', campaign.brand.name)

      const updated = await tx.placement.update({
        where: { id: placementId },
        data: {
          state: 'APPROVED',
          disclosureTextIssued: disclosure,
          disclosureToken: randomToken(6),
          deadlineAt: new Date(now.getTime() + TIMEOUT_MS.approvedToPublish),
        },
      })

      // First approval promotes the participant to ACTIVE (docs/03 section 3).
      await activateIfFirstApproval(entity.userId as string, tx)
      return updated
    },
    events: () => [{ name: 'placement/approved', data: { placementId } }],
  })
  return result.to as PlacementState
}

/** P-06 brand rejection: bounce back to positioning once, then final. */
export async function brandReject(
  placementId: string,
  reason: string,
  actor: ActorRef,
): Promise<{ state: PlacementState; final: boolean }> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { regenCount: true },
  })
  const bounced = await prisma.placementEvent.count({ where: { placementId, type: 'REJECT_B' } })
  const final = bounced >= LIMITS.maxBrandBounces

  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: final ? 'BRAND_REJECT_FINAL' : 'BRAND_REJECT_BOUNCE',
    actor,
    reason,
    load: load(placementId),
    apply: async (tx) => {
      await tx.placementEvent.create({
        data: {
          placementId,
          type: 'REJECT_B',
          payload: { reason, final, regenCount: placement.regenCount } as Prisma.InputJsonValue,
        },
      })
      if (final) {
        await releaseIfHeld(tx, placementId, 'Brand rejected')
        return tx.placement.update({
          where: { id: placementId },
          data: { state: 'REJECTED_BY_BRAND', rejectNote: reason },
        })
      }
      return tx.placement.update({ where: { id: placementId }, data: { state: 'POSITIONED', rejectNote: reason } })
    },
    events: () => [{ name: 'placement/rejected', data: { placementId, by: 'brand', reason, final } }],
  })

  return { state: result.to as PlacementState, final }
}

// ---------------------------------------------------------------- P-08 publish

export function holdDurationMs(contentType: string | null): number {
  if (contentType === 'story') return HOLD_MS.story
  if (contentType === 'reel') return HOLD_MS.reel
  return HOLD_MS.post
}

/** P-07 -> P-08. Starts the hold; verification runs when it ends. */
export async function publish(
  placementId: string,
  args: { postUrl: string; postPlatformId?: string },
  actor: ActorRef,
  now: Date = new Date(),
): Promise<{ state: PlacementState; holdEndsAt: Date }> {
  let holdEndsAt = now

  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'PUBLISH',
    actor,
    payload: { postUrl: args.postUrl },
    load: load(placementId),
    apply: async (tx, { entity }) => {
      holdEndsAt = new Date(now.getTime() + holdDurationMs(entity.contentType as string | null))
      return tx.placement.update({
        where: { id: placementId },
        data: {
          state: 'PUBLISHED',
          postUrl: args.postUrl,
          postPlatformId: args.postPlatformId ?? null,
          publishedAt: now,
          holdEndsAt,
          deadlineAt: holdEndsAt,
        },
      })
    },
    events: () => [{ name: 'placement/published', data: { placementId, holdEndsAt: holdEndsAt.toISOString() } }],
  })

  return { state: result.to as PlacementState, holdEndsAt }
}

/** P-08 -> P-09 when the hold ends. */
export async function holdEnded(placementId: string, actor: ActorRef = SYSTEM): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'HOLD_END',
    actor,
    load: load(placementId),
    apply: async (tx) => tx.placement.update({ where: { id: placementId }, data: { state: 'VERIFYING' } }),
    events: () => [{ name: 'placement/hold.ended', data: { placementId } }],
  })
  return result.to as PlacementState
}

// ---------------------------------------------------------------- P-09/P-10 outcome

export async function flagForOps(placementId: string, reason: string, actor: ActorRef = SYSTEM) {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'FLAG',
    actor,
    reason,
    load: load(placementId),
    apply: async (tx) => tx.placement.update({ where: { id: placementId }, data: { state: 'FLAGGED' } }),
    events: () => [{ name: 'placement/flagged', data: { placementId, reason } }],
  })
  return result.to as PlacementState
}

/**
 * P-09 -> P-10. Computes the settlement from the verified qualified views and writes
 * all four ledger entries in the same transaction (docs/05 `settle`).
 */
export async function qualify(
  placementId: string,
  qualifiedViews: number,
  actor: ActorRef = SYSTEM,
): Promise<{ state: PlacementState; toUserOre: number; allInOre: number }> {
  let toUserOre = 0
  let allInOre = 0

  const current = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { state: true },
  })

  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: current.state === 'FLAGGED' ? 'UNFLAG_QUALIFY' : 'QUALIFY',
    actor,
    payload: { qualifiedViews },
    load: load(placementId),
    apply: async (tx, { entity }) => {
      const campaign = await tx.campaign.findUniqueOrThrow({
        where: { id: entity.campaignId as string },
        include: { payoutTemplate: true },
      })
      if (!campaign.payoutTemplate) throw new GuardError('NO_TEMPLATE', 'Campaign has no payout template')

      const wallet = await tx.wallet.upsert({
        where: { userId: entity.userId as string },
        create: { userId: entity.userId as string },
        update: {},
        select: { id: true },
      })

      const settlement = computeSettle(
        campaign.payoutTemplate,
        qualifiedViews,
        entity.reservationOre as number,
      )
      toUserOre = settlement.toUserOre
      allInOre = settlement.allInOre

      await settlePlacement(tx, {
        campaignId: entity.campaignId as string,
        placementId,
        walletId: wallet.id,
        allInOre: settlement.allInOre,
        toUserOre: settlement.toUserOre,
        toNodOre: settlement.toNodOre,
        releaseOre: settlement.releaseOre,
      })

      await tx.verification.update({
        where: { placementId },
        data: { qualifiedViews, decidedAt: new Date() },
      })

      return tx.placement.update({
        where: { id: placementId },
        data: { state: 'QUALIFIED', settledAt: new Date() },
      })
    },
    events: () => [
      { name: 'placement/qualified', data: { placementId, qualifiedViews, toUserOre } },
      { name: 'money/payout.accrued', data: { placementId, amountOre: toUserOre } },
    ],
  })

  return { state: result.to as PlacementState, toUserOre, allInOre }
}

/** QUALIFIED -> PAID. The accrual already exists; this marks it visible in the wallet. */
export async function markPaid(placementId: string, actor: ActorRef = SYSTEM): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'PAY',
    actor,
    load: load(placementId),
    apply: async (tx) =>
      tx.placement.update({ where: { id: placementId }, data: { state: 'PAID', paidAt: new Date() } }),
    events: () => [{ name: 'placement/paid', data: { placementId } }],
  })
  return result.to as PlacementState
}

export type RejectInput = {
  placementId: string
  reason: RejectReason
  note?: string
  /** Strike to record, if this rejection is the participant's fault (docs/03). */
  strike?: 'MINOR' | 'SERIOUS'
  /** Give the participant a 12h window to add the disclosure and be re-verified. */
  fixWindow?: boolean
}

/** Any rejection path. Always releases the reservation. */
export async function reject(
  input: RejectInput,
  actor: ActorRef = SYSTEM,
  now: Date = new Date(),
): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: input.placementId,
    table: PLACEMENT_TABLE,
    event: 'REJECT',
    actor,
    reason: input.note ?? input.reason,
    payload: { reason: input.reason },
    load: load(input.placementId),
    apply: async (tx, { entity }) => {
      await releaseIfHeld(tx, input.placementId, `Rejected: ${input.reason}`)

      if (input.strike) {
        await addStrike(
          {
            userId: entity.userId as string,
            severity: input.strike,
            reason: input.reason,
            placementId: input.placementId,
          },
          actor,
          tx,
        )
      }

      return tx.placement.update({
        where: { id: input.placementId },
        data: {
          state: 'REJECTED',
          rejectReason: input.reason,
          rejectNote: input.note ?? null,
          fixWindowEndsAt: input.fixWindow ? new Date(now.getTime() + TIMEOUT_MS.disclosureFix) : null,
        },
      })
    },
    events: () => [
      { name: 'placement/rejected', data: { placementId: input.placementId, reason: input.reason } },
      ...(input.fixWindow
        ? ([
            {
              name: 'placement/disclosure.fix.window',
              data: { placementId: input.placementId },
            },
          ] as const)
        : []),
    ],
  })
  return result.to as PlacementState
}

/** Timeout expiry from any timed state. Always releases the reservation. */
export async function expire(placementId: string, actor: ActorRef = SYSTEM): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'EXPIRE',
    actor,
    load: load(placementId),
    apply: async (tx) => {
      await releaseIfHeld(tx, placementId, 'Timed out')
      return tx.placement.update({ where: { id: placementId }, data: { state: 'EXPIRED' } })
    },
    events: () => [{ name: 'placement/expired', data: { placementId } }],
  })
  return result.to as PlacementState
}

// ---------------------------------------------------------------- disputes

export async function raiseDispute(placementId: string, reason: string, actor: ActorRef): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'DISPUTE',
    actor,
    reason,
    load: load(placementId),
    apply: async (tx) => {
      await tx.dispute.upsert({
        where: { placementId },
        create: { placementId, raisedBy: actor.id ?? 'brand', reason },
        update: { reason, state: 'OPEN' },
      })
      return tx.placement.update({ where: { id: placementId }, data: { state: 'DISPUTED' } })
    },
    events: () => [{ name: 'placement/rejected', data: { placementId, disputed: true, reason } }],
  })
  return result.to as PlacementState
}

/**
 * Ops resolves a dispute. Payouts stand unless proven — NOD absorbs the cost in the
 * pilot (edge case 8), so this never reverses a PAYOUT_ACCRUE. An upheld dispute is
 * recorded and settled against NOD's own margin outside this function.
 */
export async function resolveDispute(
  placementId: string,
  args: { upheld: boolean; resolution: string },
  actor: ActorRef,
): Promise<PlacementState> {
  const result = await runTransition({
    entity: 'Placement',
    entityId: placementId,
    table: PLACEMENT_TABLE,
    event: 'RESOLVE_DISPUTE',
    actor,
    reason: args.resolution,
    load: load(placementId),
    apply: async (tx) => {
      await tx.dispute.update({
        where: { placementId },
        data: {
          state: args.upheld ? 'UPHELD' : 'REJECTED',
          resolution: args.resolution,
          resolvedAt: new Date(),
        },
      })
      return tx.placement.update({ where: { id: placementId }, data: { state: 'PAID' } })
    },
    events: () => [{ name: 'placement/paid', data: { placementId, disputeResolved: true } }],
  })
  return result.to as PlacementState
}

// ---------------------------------------------------------------- queries

/** Placements whose deadline has passed — the timeout sweep reads this. */
export async function overdue(now: Date = new Date()) {
  return prisma.placement.findMany({
    where: {
      deletedAt: null,
      clockPausedAt: null,
      deadlineAt: { lte: now },
      state: { in: HOLDS_RESERVATION.filter((s) => s !== 'PUBLISHED' && s !== 'VERIFYING' && s !== 'FLAGGED') },
    },
    select: { id: true, state: true, campaignId: true, userId: true },
  })
}

/** Placements whose hold window has closed and that are ready to verify. */
export async function holdsDue(now: Date = new Date()) {
  return prisma.placement.findMany({
    where: { deletedAt: null, state: 'PUBLISHED', holdEndsAt: { lte: now } },
    select: { id: true, campaignId: true, contentType: true },
  })
}
