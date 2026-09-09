/**
 * Submission lifecycle — docs/14 §2-5, steps S-01 to S-06. One submitted post in a CLIP
 * campaign.
 *
 * Money rules (docs/14 D2): the reservation is written in the same transaction as the
 * submit, sized min(per-post cap, available). Every terminal non-paid state releases it,
 * and every release runs a top-up pass so the oldest under-reserved submissions in the
 * campaign pick the money up in `submittedAt` order. Nothing here does arithmetic on
 * payouts — that is `lib/money/calc.ts`.
 */

import type { Prisma, SubmissionRejectReason, SubmissionState } from '@prisma/client'
import { prisma } from '@/lib/db'
import { emit } from '@/lib/events'
import { campaignBalance } from '@/lib/money/balances'
import { alreadyPosted, releaseSubmissionReservation, reserveForSubmission, settleRef, settleSubmission } from '@/lib/money/ledger'
import { settle as computeSettle } from '@/lib/money/calc'
import { TIMEOUT_MS } from '@/lib/money/rates'
import { parsePostUrl, PostUrlParseError } from '@/lib/post-url'
import { bucketOf, nextCheckAt as computeNextCheck, submissionReservationOre } from '@/lib/clips/rules'
import { exhaust, isClaimable, markFilling } from './campaign'
import { addStrike } from './participant'
import { suspendMembership } from './membership'
import {
  GuardError,
  runTransition,
  SYSTEM,
  type ActorRef,
  type TransitionTable,
  type Tx,
} from './transition'

export type SubmissionEvent =
  | 'VERIFIED'
  | 'NEEDS_DISCLOSURE'
  | 'WINDOW_END'
  | 'QUALIFY'
  | 'HOLD'
  | 'REJECT'
  | 'PAY'

/** docs/14 §2 — the table is the spec. */
export const SUBMISSION_TABLE: TransitionTable<SubmissionState, SubmissionEvent> = {
  RECEIVED: { VERIFIED: 'TRACKING', NEEDS_DISCLOSURE: 'FIX_DISCLOSURE', REJECT: 'REJECTED' },
  FIX_DISCLOSURE: { VERIFIED: 'TRACKING', REJECT: 'REJECTED' },
  TRACKING: { WINDOW_END: 'VALIDATING', REJECT: 'REJECTED' },
  VALIDATING: { QUALIFY: 'QUALIFIED', HOLD: 'HELD', REJECT: 'REJECTED' },
  HELD: { QUALIFY: 'QUALIFIED', REJECT: 'REJECTED' },
  QUALIFIED: { PAY: 'PAID' },
  PAID: {},
  REJECTED: {},
}

/** States that still hold budget. */
export const HOLDS_RESERVATION: SubmissionState[] = ['RECEIVED', 'FIX_DISCLOSURE', 'TRACKING', 'VALIDATING', 'HELD']
export const TERMINAL_STATES: SubmissionState[] = ['PAID', 'REJECTED']
/** Campaign states that accept a new submission (EXHAUSTED tracks but does not pay — D2). */
export const SUBMITTABLE_CAMPAIGN_STATES = ['LIVE', 'FILLING', 'EXHAUSTED'] as const

export class SubmitError extends GuardError {}

const load = (id: string) => async (tx: Tx) =>
  tx.submission.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      state: true,
      campaignId: true,
      membershipId: true,
      userId: true,
      socialAccountId: true,
      platform: true,
      reservationOre: true,
      publishedAt: true,
      submittedAt: true,
      validationEndsAt: true,
      initialViews: true,
      latestViews: true,
      eligibleViews: true,
      consecutiveFailures: true,
    },
  })

// ---------------------------------------------------------------- S-01 submit

export type SubmitInput = {
  campaignId: string
  userId: string
  url: string
}

export type SubmitResult = {
  id: string
  reservationOre: number
  budgetExhausted: boolean
  platform: 'INSTAGRAM' | 'TIKTOK'
  postId: string
}

/**
 * S-01 RECEIVED. Synchronous part of the loop (docs/14 D7): parse, check, reserve, insert.
 * Ownership and caption checks happen in the verify job that `submission/received` starts.
 */
export async function submitPost(input: SubmitInput, now: Date = new Date()): Promise<SubmitResult> {
  let parsed
  try {
    parsed = parsePostUrl(input.url)
  } catch (error) {
    if (error instanceof PostUrlParseError) throw new SubmitError(`URL_${error.code}`, error.message)
    throw error
  }

  const result = await prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({
      where: { id: input.campaignId },
      select: {
        kind: true,
        state: true,
        endsAt: true,
        platforms: true,
        perPersonCap: true,
        perPlacementMax: true,
        submissionsPausedAt: true,
        payoutTemplate: { select: { id: true } },
      },
    })
    if (campaign.kind !== 'CLIP') throw new SubmitError('NOT_CLIP', 'Not a clip campaign')
    if (!SUBMITTABLE_CAMPAIGN_STATES.includes(campaign.state as (typeof SUBMITTABLE_CAMPAIGN_STATES)[number])) {
      throw new SubmitError('CAMPAIGN_NOT_OPEN', `Campaign is ${campaign.state}`)
    }
    if (!campaign.payoutTemplate) throw new SubmitError('NO_TEMPLATE', 'Campaign has no payout template')
    if (campaign.endsAt && campaign.endsAt <= now) throw new SubmitError('CAMPAIGN_ENDED', 'Campaign has ended')
    if (campaign.submissionsPausedAt) throw new SubmitError('SUBMISSIONS_PAUSED', 'Submissions are paused')
    if (!campaign.platforms.includes(parsed.platform)) throw new SubmitError('PLATFORM', `Campaign does not run on ${parsed.platform}`)

    const membership = await tx.campaignMembership.findUnique({
      where: { campaignId_userId: { campaignId: input.campaignId, userId: input.userId } },
      select: { id: true, state: true },
    })
    if (!membership || membership.state !== 'JOINED') throw new SubmitError('NOT_JOINED', 'Join the campaign first')

    // D5: the post must come from an API-connected account of this creator on that platform.
    const account = await tx.socialAccount.findFirst({
      where: { userId: input.userId, platform: parsed.platform, tier: 'CONNECTED_API', deletedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!account) throw new SubmitError('NO_CONNECTED_ACCOUNT', `Connect your ${parsed.platform} account first`)

    const duplicate = await tx.submission.findUnique({
      where: { campaignId_platform_postId: { campaignId: input.campaignId, platform: parsed.platform, postId: parsed.postId } },
      select: { id: true },
    })
    if (duplicate) throw new SubmitError('DUPLICATE', 'That post has already been submitted to this campaign')

    const mine = await tx.submission.count({
      where: { campaignId: input.campaignId, userId: input.userId, deletedAt: null, state: { not: 'REJECTED' } },
    })
    if (mine >= campaign.perPersonCap) throw new SubmitError('CAP', `Cap of ${campaign.perPersonCap} posts reached`)

    const balance = await campaignBalance(tx, input.campaignId)
    const reservationOre = submissionReservationOre(campaign.perPlacementMax, balance.availableOre)
    const budgetExhausted = reservationOre === 0

    const submission = await tx.submission.create({
      data: {
        campaignId: input.campaignId,
        membershipId: membership.id,
        userId: input.userId,
        socialAccountId: account.id,
        platform: parsed.platform,
        postId: parsed.postId,
        canonicalUrl: parsed.canonicalUrl,
        state: 'RECEIVED',
        reservationOre,
        budgetExhausted,
        submittedAt: now,
      },
      select: { id: true },
    })

    await reserveForSubmission(tx, input.campaignId, submission.id, reservationOre)

    await tx.auditLog.create({
      data: {
        entity: 'Submission',
        entityId: submission.id,
        toState: 'RECEIVED',
        event: 'SUBMIT',
        actor: `participant:${input.userId}`,
        payload: { reservationOre, budgetExhausted, platform: parsed.platform, postId: parsed.postId } as Prisma.InputJsonValue,
      },
    })

    await markFilling(input.campaignId, tx)
    const after = await campaignBalance(tx, input.campaignId)
    if (after.availableOre <= 0 && isClaimable(campaign.state)) await exhaust(input.campaignId, SYSTEM, tx)

    return { id: submission.id, reservationOre, budgetExhausted, platform: parsed.platform, postId: parsed.postId }
  })

  await emit({ name: 'submission/received', data: { submissionId: result.id, campaignId: input.campaignId, userId: input.userId } })
  return result
}

// ---------------------------------------------------------------- reservation helpers

/** Release exactly once — reads the ledger, not the state, so a double call is a no-op. */
async function releaseIfHeld(tx: Tx, submissionId: string, memo: string): Promise<number> {
  const submission = await tx.submission.findUniqueOrThrow({ where: { id: submissionId }, select: { campaignId: true } })
  const entries = await tx.ledgerEntry.findMany({
    where: { submissionId, type: { in: ['RESERVE', 'RELEASE_RESERVATION', 'SETTLE'] } },
    select: { type: true, amountOre: true },
  })
  const sum = (type: string) => entries.filter((e) => e.type === type).reduce((s, e) => s + e.amountOre, 0)
  const outstanding = sum('RESERVE') - sum('RELEASE_RESERVATION') - sum('SETTLE')
  if (outstanding <= 0) return 0
  await releaseSubmissionReservation(tx, submission.campaignId, submissionId, outstanding, memo)
  return outstanding
}

/**
 * docs/14 D2 "first-validated wins": whenever budget comes back (a reject, a settlement
 * remainder), hand it to the oldest submissions that hold less than the per-post cap.
 * Runs inside the caller's transaction so the money never sits unassigned.
 */
export async function topUpReservations(tx: Tx, campaignId: string): Promise<number> {
  const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { perPlacementMax: true, endsAt: true } })
  let available = (await campaignBalance(tx, campaignId)).availableOre
  if (available <= 0) return 0

  const candidates = await tx.submission.findMany({
    where: { campaignId, deletedAt: null, state: { in: HOLDS_RESERVATION }, reservationOre: { lt: campaign.perPlacementMax } },
    orderBy: { submittedAt: 'asc' },
    select: { id: true, reservationOre: true },
    take: 500,
  })

  let toppedUp = 0
  for (const s of candidates) {
    if (available <= 0) break
    const add = Math.min(campaign.perPlacementMax - s.reservationOre, available)
    if (add <= 0) continue
    await reserveForSubmission(tx, campaignId, s.id, add, 'Reservation top-up from released budget')
    await tx.submission.update({ where: { id: s.id }, data: { reservationOre: s.reservationOre + add, budgetExhausted: false } })
    await tx.auditLog.create({
      data: { entity: 'Submission', entityId: s.id, event: 'RESERVATION_TOP_UP', actor: 'system', payload: { addOre: add } as Prisma.InputJsonValue },
    })
    available -= add
    toppedUp += 1
  }
  return toppedUp
}

// ---------------------------------------------------------------- S-01 → S-03 verification outcomes

export type Observation = {
  views: number
  likes?: number
  comments?: number
  shares?: number
  observedAt?: Date
}

export type VerifiedInput = {
  submissionId: string
  providerMediaId?: string | null
  caption: string | null
  publishedAt: Date
  initial: Observation
}

/** RECEIVED | FIX_DISCLOSURE → TRACKING. Stores the baseline the eligible views count from. */
export async function verificationPassed(input: VerifiedInput, actor: ActorRef = SYSTEM, now: Date = new Date()): Promise<SubmissionState> {
  const result = await runTransition({
    entity: 'Submission',
    entityId: input.submissionId,
    table: SUBMISSION_TABLE,
    event: 'VERIFIED',
    actor,
    payload: { initialViews: input.initial.views },
    load: load(input.submissionId),
    apply: async (tx, { entity }) => {
      const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: entity.campaignId as string }, select: { validationHours: true } })
      const submittedAt = entity.submittedAt as Date
      const validationEndsAt = new Date(submittedAt.getTime() + campaign.validationHours * 60 * 60 * 1000)
      const next = computeNextCheck(now, input.publishedAt, 0, validationEndsAt)
      const observedAt = input.initial.observedAt ?? now

      await tx.submissionSnapshot.createMany({
        data: [snapshotRow(input.submissionId, input.initial, observedAt)],
        skipDuplicates: true,
      })

      return tx.submission.update({
        where: { id: input.submissionId },
        data: {
          state: 'TRACKING',
          providerMediaId: input.providerMediaId ?? null,
          caption: input.caption,
          publishedAt: input.publishedAt,
          initialViews: input.initial.views,
          latestViews: input.initial.views,
          eligibleViews: 0,
          latestLikes: input.initial.likes ?? 0,
          latestComments: input.initial.comments ?? 0,
          latestShares: input.initial.shares ?? 0,
          lastCheckedAt: observedAt,
          validationEndsAt,
          nextCheckAt: next.at,
          priority: next.priority,
          fixWindowEndsAt: null,
          consecutiveFailures: 0,
          consecutiveMissing: 0,
        },
      })
    },
    events: () => [{ name: 'submission/tracking', data: { submissionId: input.submissionId } }],
  })
  return result.to as SubmissionState
}

/** RECEIVED → FIX_DISCLOSURE. 12 h to add the disclosure / required tags (docs/14 D6). */
export async function needsDisclosureFix(
  submissionId: string,
  detail: { missingHashtags: string[]; missingMentions: string[]; disclosureOk: boolean },
  actor: ActorRef = SYSTEM,
  now: Date = new Date(),
): Promise<SubmissionState> {
  const result = await runTransition({
    entity: 'Submission',
    entityId: submissionId,
    table: SUBMISSION_TABLE,
    event: 'NEEDS_DISCLOSURE',
    actor,
    payload: detail,
    load: load(submissionId),
    apply: async (tx) =>
      tx.submission.update({
        where: { id: submissionId },
        data: { state: 'FIX_DISCLOSURE', fixWindowEndsAt: new Date(now.getTime() + TIMEOUT_MS.disclosureFix) },
      }),
    events: () => [{ name: 'submission/disclosure.fix.window', data: { submissionId } }],
  })
  return result.to as SubmissionState
}

// ---------------------------------------------------------------- tracking observations (not a transition)

function snapshotRow(submissionId: string, o: Observation, observedAt: Date) {
  return {
    submissionId,
    observedAt,
    bucket: bucketOf(observedAt),
    views: o.views,
    likes: o.likes ?? 0,
    comments: o.comments ?? 0,
    shares: o.shares ?? 0,
  }
}

export type ObservationOutcome = { recorded: boolean; decreased: boolean; eligibleViews: number }

/**
 * Store one metrics observation. Idempotent per 5-minute bucket; `latestViews` is
 * monotonic and a decrease is reported (risk factor) rather than applied. Schedules the
 * next check. Callable on TRACKING and VALIDATING rows (the final pull).
 */
export async function recordObservation(
  submissionId: string,
  o: Observation,
  now: Date = new Date(),
  tx: Tx = prisma,
): Promise<ObservationOutcome> {
  const s = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { state: true, publishedAt: true, initialViews: true, latestViews: true, validationEndsAt: true, riskFactors: true },
  })
  if (s.state !== 'TRACKING' && s.state !== 'VALIDATING') return { recorded: false, decreased: false, eligibleViews: 0 }

  const observedAt = o.observedAt ?? now
  const created = await tx.submissionSnapshot.createMany({ data: [snapshotRow(submissionId, o, observedAt)], skipDuplicates: true })

  const decreased = o.views < s.latestViews && s.latestViews - o.views > Math.max(50, s.latestViews * 0.02)
  const latestViews = Math.max(s.latestViews, o.views)
  const eligibleViews = Math.max(0, latestViews - s.initialViews)
  const next = computeNextCheck(now, s.publishedAt ?? now, 0, s.validationEndsAt)

  await tx.submission.update({
    where: { id: submissionId },
    data: {
      latestViews,
      eligibleViews,
      latestLikes: o.likes ?? undefined,
      latestComments: o.comments ?? undefined,
      latestShares: o.shares ?? undefined,
      lastCheckedAt: observedAt,
      nextCheckAt: s.state === 'TRACKING' ? next.at : null,
      priority: next.priority,
      queuedAt: null,
      consecutiveFailures: 0,
      consecutiveMissing: 0,
      trackingPausedAt: null,
      ...(decreased && !s.riskFactors.includes('views_decreased') ? { riskFactors: { push: 'views_decreased' } } : {}),
    },
  })

  if (decreased) await emit({ name: 'submission/risk', data: { submissionId, factor: 'views_decreased', from: s.latestViews, to: o.views } })
  return { recorded: created.count > 0, decreased, eligibleViews }
}

/** A check that errored (rate limit, 5xx). Backs off; never changes state. */
export async function recordCheckFailure(submissionId: string, now: Date = new Date(), tx: Tx = prisma): Promise<void> {
  const s = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { state: true, publishedAt: true, consecutiveFailures: true, validationEndsAt: true },
  })
  if (s.state !== 'TRACKING') return
  const failures = s.consecutiveFailures + 1
  const next = computeNextCheck(now, s.publishedAt ?? now, failures, s.validationEndsAt)
  await tx.submission.update({
    where: { id: submissionId },
    data: { consecutiveFailures: failures, nextCheckAt: next.at, priority: next.priority, queuedAt: null },
  })
}

/**
 * The provider did not return the post. Counts towards DELETED_EARLY; the caller rejects
 * when the returned count reaches the threshold.
 */
export async function recordMissing(submissionId: string, now: Date = new Date(), tx: Tx = prisma): Promise<number> {
  const s = await tx.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { state: true, publishedAt: true, consecutiveMissing: true, validationEndsAt: true },
  })
  if (s.state !== 'TRACKING' && s.state !== 'VALIDATING') return s.consecutiveMissing
  const missing = s.consecutiveMissing + 1
  const next = computeNextCheck(now, s.publishedAt ?? now, 0, s.validationEndsAt)
  await tx.submission.update({
    where: { id: submissionId },
    data: { consecutiveMissing: missing, nextCheckAt: s.state === 'TRACKING' ? next.at : null, queuedAt: null },
  })
  return missing
}

/** Dead token on the account: park every tracking submission of that account (docs/14 §4). */
export async function pauseTrackingForAccount(socialAccountId: string, untilMs: number, now: Date = new Date()): Promise<number> {
  const result = await prisma.submission.updateMany({
    where: { socialAccountId, state: 'TRACKING', deletedAt: null },
    data: { trackingPausedAt: now, nextCheckAt: new Date(now.getTime() + untilMs), queuedAt: null },
  })
  return result.count
}

// ---------------------------------------------------------------- S-03 → S-04 → S-06

/** TRACKING → VALIDATING when the window closes. */
export async function startValidating(submissionId: string, actor: ActorRef = SYSTEM): Promise<SubmissionState> {
  const result = await runTransition({
    entity: 'Submission',
    entityId: submissionId,
    table: SUBMISSION_TABLE,
    event: 'WINDOW_END',
    actor,
    load: load(submissionId),
    apply: async (tx) => tx.submission.update({ where: { id: submissionId }, data: { state: 'VALIDATING', nextCheckAt: null, queuedAt: null } }),
    events: () => [{ name: 'submission/validating', data: { submissionId } }],
  })
  return result.to as SubmissionState
}

export type QualifyInput = {
  submissionId: string
  qualifiedViews: number
  riskScore: number
  riskFactors: string[]
}

/**
 * VALIDATING | HELD → QUALIFIED. Settles into the ledger, capped by the reservation, and
 * tops up the campaign with the remainder. Idempotent: a replayed job finds the SETTLE
 * row by `externalRef` and the transition table refuses a second QUALIFY anyway.
 */
export async function qualifySubmission(
  input: QualifyInput,
  actor: ActorRef = SYSTEM,
): Promise<{ state: SubmissionState; toUserOre: number; allInOre: number }> {
  let toUserOre = 0
  let allInOre = 0

  const result = await runTransition({
    entity: 'Submission',
    entityId: input.submissionId,
    table: SUBMISSION_TABLE,
    event: 'QUALIFY',
    actor,
    payload: { qualifiedViews: input.qualifiedViews, riskScore: input.riskScore },
    load: load(input.submissionId),
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

      const settlement = computeSettle(campaign.payoutTemplate, input.qualifiedViews, entity.reservationOre as number)
      toUserOre = settlement.toUserOre
      allInOre = settlement.allInOre

      if (!(await alreadyPosted(tx, settleRef(input.submissionId)))) {
        await settleSubmission(tx, {
          campaignId: entity.campaignId as string,
          submissionId: input.submissionId,
          walletId: wallet.id,
          allInOre: settlement.allInOre,
          toUserOre: settlement.toUserOre,
          toNodOre: settlement.toNodOre,
          releaseOre: settlement.releaseOre,
        })
      }

      const updated = await tx.submission.update({
        where: { id: input.submissionId },
        data: {
          state: 'QUALIFIED',
          settledAt: new Date(),
          riskScore: input.riskScore,
          riskFactors: input.riskFactors,
          nextCheckAt: null,
        },
      })
      if (settlement.releaseOre > 0) await topUpReservations(tx, entity.campaignId as string)
      return updated
    },
    events: () => [
      { name: 'submission/qualified', data: { submissionId: input.submissionId, qualifiedViews: input.qualifiedViews, toUserOre } },
      { name: 'money/payout.accrued', data: { submissionId: input.submissionId, amountOre: toUserOre } },
    ],
  })

  return { state: result.to as SubmissionState, toUserOre, allInOre }
}

/** VALIDATING → HELD for ops (risk band 60-79, or an anomaly). Keeps the reservation. */
export async function holdSubmission(
  submissionId: string,
  detail: { reason: string; riskScore: number; riskFactors: string[] },
  actor: ActorRef = SYSTEM,
): Promise<SubmissionState> {
  const result = await runTransition({
    entity: 'Submission',
    entityId: submissionId,
    table: SUBMISSION_TABLE,
    event: 'HOLD',
    actor,
    reason: detail.reason,
    payload: { riskScore: detail.riskScore, riskFactors: detail.riskFactors },
    load: load(submissionId),
    apply: async (tx) =>
      tx.submission.update({
        where: { id: submissionId },
        data: { state: 'HELD', riskScore: detail.riskScore, riskFactors: detail.riskFactors, nextCheckAt: null },
      }),
    events: () => [{ name: 'submission/held', data: { submissionId, reason: detail.reason } }],
  })
  return result.to as SubmissionState
}

/** QUALIFIED → PAID once the accrual is visible in the wallet. */
export async function markSubmissionPaid(submissionId: string, actor: ActorRef = SYSTEM): Promise<SubmissionState> {
  const result = await runTransition({
    entity: 'Submission',
    entityId: submissionId,
    table: SUBMISSION_TABLE,
    event: 'PAY',
    actor,
    load: load(submissionId),
    apply: async (tx) => tx.submission.update({ where: { id: submissionId }, data: { state: 'PAID', paidAt: new Date() } }),
    events: () => [{ name: 'submission/paid', data: { submissionId } }],
  })
  return result.to as SubmissionState
}

export type RejectSubmissionInput = {
  submissionId: string
  reason: SubmissionRejectReason
  note?: string
  strike?: 'MINOR' | 'SERIOUS'
  /** Two fraud rejects suspend the membership (docs/14 §5). */
  suspendMembershipIfRepeat?: boolean
}

/** Any rejection path. Always releases the reservation and tops the campaign up. */
export async function rejectSubmission(
  input: RejectSubmissionInput,
  actor: ActorRef = SYSTEM,
): Promise<SubmissionState> {
  const result = await runTransition({
    entity: 'Submission',
    entityId: input.submissionId,
    table: SUBMISSION_TABLE,
    event: 'REJECT',
    actor,
    reason: input.note ?? input.reason,
    payload: { reason: input.reason },
    load: load(input.submissionId),
    apply: async (tx, { entity }) => {
      await releaseIfHeld(tx, input.submissionId, `Rejected: ${input.reason}`)

      if (input.strike) {
        await addStrike(
          { userId: entity.userId as string, severity: input.strike, reason: `submission:${input.reason}` },
          actor,
          tx,
        )
      }

      const updated = await tx.submission.update({
        where: { id: input.submissionId },
        // The column mirrors what the ledger currently holds for this row: nothing, after a release.
        data: { state: 'REJECTED', rejectReason: input.reason, rejectNote: input.note ?? null, reservationOre: 0, nextCheckAt: null, fixWindowEndsAt: null },
      })

      if (input.suspendMembershipIfRepeat && input.reason === 'FRAUD') {
        const fraudRejects = await tx.submission.count({
          where: { userId: entity.userId as string, rejectReason: 'FRAUD', deletedAt: null },
        })
        const membership = await tx.campaignMembership.findUnique({
          where: { id: entity.membershipId as string },
          select: { state: true },
        })
        if (fraudRejects >= 2 && membership?.state === 'JOINED') {
          await suspendMembership(entity.membershipId as string, `${fraudRejects} fraud rejections`, actor, tx)
        }
      }

      await topUpReservations(tx, entity.campaignId as string)
      return updated
    },
    events: () => [{ name: 'submission/rejected', data: { submissionId: input.submissionId, reason: input.reason } }],
  })
  return result.to as SubmissionState
}

// ---------------------------------------------------------------- queries for the jobs

/** Rows the scheduler should fan out now (docs/14 §4). */
export async function dueForTracking(now: Date = new Date(), limit = 2000) {
  return prisma.submission.findMany({
    where: {
      state: 'TRACKING',
      deletedAt: null,
      nextCheckAt: { lte: now },
      OR: [{ queuedAt: null }, { queuedAt: { lt: new Date(now.getTime() - 15 * 60 * 1000) } }],
    },
    orderBy: [{ priority: 'asc' }, { nextCheckAt: 'asc' }],
    take: limit,
    select: { id: true, platform: true, socialAccountId: true },
  })
}

export async function validationsDue(now: Date = new Date()) {
  return prisma.submission.findMany({
    where: { state: 'TRACKING', deletedAt: null, validationEndsAt: { lte: now } },
    select: { id: true },
    take: 5000,
  })
}

export async function fixWindowsDue(now: Date = new Date()) {
  return prisma.submission.findMany({
    where: { state: 'FIX_DISCLOSURE', deletedAt: null, fixWindowEndsAt: { lte: now } },
    select: { id: true },
  })
}

/** Received rows the verify job never resolved — surfaced to ops after 24 h. */
export async function staleReceived(now: Date = new Date(), olderThanMs = 24 * 60 * 60 * 1000) {
  return prisma.submission.findMany({
    where: { state: 'RECEIVED', deletedAt: null, submittedAt: { lte: new Date(now.getTime() - olderThanMs) } },
    select: { id: true },
  })
}
