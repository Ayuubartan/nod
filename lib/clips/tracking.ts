/**
 * S-03 tracking and S-04/S-06 validation for clip submissions — docs/14 §4-5.
 *
 * Pure orchestration over the state functions in lib/state/submission.ts; the Inngest
 * functions in inngest/clips.ts are thin wrappers so everything here runs in a test
 * without a queue. Every entry point is idempotent: snapshots dedupe per 5-minute
 * bucket, transitions refuse to repeat, and settlement is keyed by externalRef.
 */

import type { AccountPlatform } from '@prisma/client'
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { flag } from '@/lib/flags'
import { assessFraud } from '@/lib/fraud'
import { ProviderError, type PostMetrics } from '@/lib/integrations/types'
import { providerFor } from '@/lib/integrations/social'
import { freshToken } from '@/lib/social-sync'
import { clipRiskFactors, MISSING_CHECKS_TO_REJECT, riskBand, TOKEN_PAUSE_MS } from '@/lib/clips/rules'
import {
  dueForTracking,
  holdSubmission,
  pauseTrackingForAccount,
  qualifySubmission,
  recordCheckFailure,
  recordMissing,
  recordObservation,
  rejectSubmission,
  startValidating,
  validationsDue,
} from '@/lib/state/submission'
import { notifyClipQualified, notifyClipRejected, notifyClipTokenPaused } from '@/lib/notify'

/** Ids per provider call (docs/14 §4): TikTok video/query takes 20, Instagram is one GET per id. */
export const BATCH_SIZE: Record<AccountPlatform, number> = { TIKTOK: 20, INSTAGRAM: 10 }

export type TrackBatch = { platform: AccountPlatform; socialAccountId: string; submissionIds: string[] }

/** Signals the Inngest wrapper to back off the whole platform worker. */
export class TrackingRateLimited extends Error {
  constructor(readonly platform: AccountPlatform, readonly retryAfterMs: number) {
    super(`${platform} rate limited; retry in ${retryAfterMs} ms`)
  }
}

// ---------------------------------------------------------------- scheduler

/**
 * Select due rows, group per (platform, account) so one token serves a whole chunk,
 * stamp `queuedAt` and return the batches to fan out. Platforms whose circuit breaker
 * is off are left alone: their rows keep `nextCheckAt` and catch up later.
 */
export async function planTrackingBatches(now: Date = new Date(), limit = 2000): Promise<TrackBatch[]> {
  const enabled: Record<AccountPlatform, boolean> = {
    TIKTOK: await flag('tracking.tiktok.enabled'),
    INSTAGRAM: await flag('tracking.instagram.enabled'),
  }
  const due = await dueForTracking(now, limit)

  const groups = new Map<string, TrackBatch>()
  for (const row of due) {
    if (!enabled[row.platform]) continue
    const key = `${row.platform}:${row.socialAccountId}`
    const group = groups.get(key) ?? { platform: row.platform, socialAccountId: row.socialAccountId, submissionIds: [] }
    group.submissionIds.push(row.id)
    groups.set(key, group)
  }

  const batches: TrackBatch[] = []
  for (const group of groups.values()) {
    const size = BATCH_SIZE[group.platform]
    for (let i = 0; i < group.submissionIds.length; i += size) {
      batches.push({ ...group, submissionIds: group.submissionIds.slice(i, i + size) })
    }
  }

  const queued = batches.flatMap((b) => b.submissionIds)
  if (queued.length > 0) {
    await prisma.submission.updateMany({ where: { id: { in: queued } }, data: { queuedAt: now } })
  }
  return batches
}

// ---------------------------------------------------------------- worker

export type TrackOutcome = {
  observed: number
  missing: number
  rejected: number
  failed: number
  skipped: number
  paused?: 'no_token' | 'unauthorized'
}

/**
 * Pull metrics for one batch and record what came back. Rows that moved on since the
 * scheduler ran are skipped; a rate limit is thrown for the worker to back off on.
 */
export async function trackBatch(batch: TrackBatch, now: Date = new Date()): Promise<TrackOutcome> {
  const outcome: TrackOutcome = { observed: 0, missing: 0, rejected: 0, failed: 0, skipped: 0 }

  const rows = await prisma.submission.findMany({
    where: { id: { in: batch.submissionIds }, socialAccountId: batch.socialAccountId, deletedAt: null },
    select: { id: true, state: true, providerMediaId: true, postId: true, userId: true },
  })
  const live = rows.filter((r) => r.state === 'TRACKING' || r.state === 'VALIDATING')
  outcome.skipped = batch.submissionIds.length - live.length
  if (live.length === 0) return outcome

  const account = await prisma.socialAccount.findUnique({
    where: { id: batch.socialAccountId },
    select: { id: true, userId: true, platform: true, accessToken: true, refreshToken: true, tokenExpiresAt: true },
  })
  const token = account ? await freshToken(account) : null
  if (!account || !token) {
    await pauseTrackingForAccount(batch.socialAccountId, TOKEN_PAUSE_MS, now)
    return { ...outcome, paused: 'no_token' }
  }

  const ids = live.map((r) => r.providerMediaId ?? r.postId)
  let metrics: Map<string, PostMetrics>
  try {
    metrics = await providerFor(batch.platform).postMetrics(token, ids)
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    if (error.kind === 'rate_limited') throw new TrackingRateLimited(batch.platform, error.retryAfterMs ?? 60_000)
    if (error.kind === 'unauthorized') {
      await pauseTrackingForAccount(batch.socialAccountId, TOKEN_PAUSE_MS, now)
      await notifyClipTokenPaused(account.userId, account.platform)
      return { ...outcome, paused: 'unauthorized' }
    }
    log.warn('clip tracking transient failure', { platform: batch.platform, accountId: account.id, error: error.message })
    for (const row of live) await recordCheckFailure(row.id, now)
    return { ...outcome, failed: live.length }
  }

  for (const row of live) {
    const post = metrics.get(row.providerMediaId ?? row.postId)
    if (post) {
      await recordObservation(
        row.id,
        { views: post.views, likes: post.likes ?? undefined, comments: post.comments ?? undefined, shares: post.shares ?? undefined, observedAt: now },
        now,
      )
      outcome.observed += 1
      continue
    }

    const misses = await recordMissing(row.id, now)
    outcome.missing += 1
    if (misses >= MISSING_CHECKS_TO_REJECT) {
      // Placement edge case 5 carried over: taking the post down mid-window forfeits it.
      await rejectSubmission({ submissionId: row.id, reason: 'DELETED_EARLY', strike: 'SERIOUS' })
      await notifyClipRejected(row.id, 'DELETED_EARLY')
      outcome.rejected += 1
    }
  }
  return outcome
}

// ---------------------------------------------------------------- validation

export type ValidationOutcome =
  | { outcome: 'qualified'; qualifiedViews: number; toUserOre: number; riskScore: number }
  | { outcome: 'held'; riskScore: number; riskFactors: string[] }
  | { outcome: 'rejected'; reason: 'FRAUD' | 'DELETED_EARLY'; riskScore?: number }
  | { outcome: 'retry'; why: 'no_token' | 'rate_limited' | 'transient' | 'unauthorized'; retryAfterMs?: number }
  | { outcome: 'skipped'; state: string }

export const VALIDATE_RETRY_MS = 10 * 60 * 1000

/**
 * The window closed: one final pull, then the fraud call and settlement (docs/14 §5).
 * Provider trouble on the final pull returns `retry` and the row stays VALIDATING —
 * never skipped, never settled on stale numbers.
 */
export async function validateSubmission(submissionId: string, now: Date = new Date()): Promise<ValidationOutcome> {
  const s = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      state: true,
      platform: true,
      userId: true,
      providerMediaId: true,
      postId: true,
      consecutiveMissing: true,
      account: {
        select: { id: true, platform: true, accessToken: true, refreshToken: true, tokenExpiresAt: true, followers: true, avgViews30d: true, createdAt: true },
      },
    },
  })
  if (!s || (s.state !== 'TRACKING' && s.state !== 'VALIDATING')) return { outcome: 'skipped', state: s?.state ?? 'MISSING' }

  if (s.state === 'TRACKING') await startValidating(submissionId)

  // 1. Final pull.
  const token = await freshToken(s.account)
  if (!token) return { outcome: 'retry', why: 'no_token', retryAfterMs: VALIDATE_RETRY_MS }
  const mediaId = s.providerMediaId ?? s.postId
  try {
    const metrics = await providerFor(s.platform).postMetrics(token, [mediaId])
    const post = metrics.get(mediaId)
    if (post) {
      await recordObservation(
        submissionId,
        { views: post.views, likes: post.likes ?? undefined, comments: post.comments ?? undefined, shares: post.shares ?? undefined, observedAt: now },
        now,
      )
    } else {
      const misses = await recordMissing(submissionId, now)
      if (misses >= MISSING_CHECKS_TO_REJECT) {
        await rejectSubmission({ submissionId, reason: 'DELETED_EARLY', strike: 'SERIOUS' })
        await notifyClipRejected(submissionId, 'DELETED_EARLY')
        return { outcome: 'rejected', reason: 'DELETED_EARLY' }
      }
      // DECISION: one miss at the deadline is not proof of deletion (provider lag is
      // common on fresh posts); ask again shortly rather than settle on the last snapshot.
      return { outcome: 'retry', why: 'transient', retryAfterMs: VALIDATE_RETRY_MS }
    }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    if (error.kind === 'unauthorized') await pauseTrackingForAccount(s.account.id, TOKEN_PAUSE_MS, now)
    return { outcome: 'retry', why: error.kind, retryAfterMs: error.retryAfterMs ?? VALIDATE_RETRY_MS }
  }

  // 2. Fraud call on the final numbers.
  const fresh = await prisma.submission.findUniqueOrThrow({
    where: { id: submissionId },
    select: { eligibleViews: true, latestLikes: true, latestComments: true, riskFactors: true, reservationOre: true },
  })
  const snapshots = await prisma.submissionSnapshot.findMany({
    where: { submissionId, deletedAt: null },
    orderBy: { observedAt: 'asc' },
    select: { observedAt: true, views: true },
  })
  const [priorQualifiedClips, priorQualifiedPlacements, priorFraudClips, priorFraudPlacements] = await Promise.all([
    prisma.submission.count({ where: { userId: s.userId, id: { not: submissionId }, state: { in: ['QUALIFIED', 'PAID'] }, deletedAt: null } }),
    prisma.placement.count({ where: { userId: s.userId, state: { in: ['QUALIFIED', 'PAID'] }, deletedAt: null } }),
    prisma.submission.count({ where: { userId: s.userId, rejectReason: 'FRAUD', deletedAt: null } }),
    prisma.placement.count({ where: { userId: s.userId, rejectReason: 'FRAUD', deletedAt: null } }),
  ])

  const base = assessFraud({
    views: fresh.eligibleViews,
    avgViews30d: s.account.avgViews30d,
    followers: s.account.followers,
    accountAgeDays: Math.floor((now.getTime() - s.account.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    engagements: fresh.latestLikes + fresh.latestComments,
    priorQualified: priorQualifiedClips + priorQualifiedPlacements,
    priorFraudRejects: priorFraudClips + priorFraudPlacements,
  })
  const clipFactors = clipRiskFactors(snapshots)
  const band = riskBand(base, clipFactors)
  const riskFactors = [
    ...new Set([
      ...fresh.riskFactors,
      ...base.factors.filter((f) => f.score >= 0.5).map((f) => f.name),
      ...clipFactors.map((f) => f.name),
    ]),
  ]

  if (band.disposition === 'REJECT_SUBMISSION') {
    await rejectSubmission({
      submissionId,
      reason: 'FRAUD',
      note: `risk ${band.score}: ${riskFactors.join(', ')}`,
      strike: 'SERIOUS',
      suspendMembershipIfRepeat: true,
    })
    await notifyClipRejected(submissionId, 'FRAUD')
    return { outcome: 'rejected', reason: 'FRAUD', riskScore: band.score }
  }

  if (band.disposition === 'HOLD_FOR_REVIEW') {
    await holdSubmission(submissionId, { reason: `risk ${band.score}`, riskScore: band.score, riskFactors })
    return { outcome: 'held', riskScore: band.score, riskFactors }
  }

  // 3. Settle. ALLOW_WITH_MONITORING pays in full; the factors stay on the row for ops.
  const qualifiedViews = Math.floor(fresh.eligibleViews * base.geoFactor * (1 - base.fraudDiscount))
  const settled = await qualifySubmission({ submissionId, qualifiedViews, riskScore: band.score, riskFactors })
  await notifyClipQualified(submissionId, settled.toUserOre, qualifiedViews)
  return { outcome: 'qualified', qualifiedViews, toUserOre: settled.toUserOre, riskScore: band.score }
}

/** Every TRACKING row whose window has closed, validated one by one. */
export async function runValidationsDue(now: Date = new Date()): Promise<ValidationOutcome[]> {
  const due = await validationsDue(now)
  const results: ValidationOutcome[] = []
  for (const row of due) results.push(await validateSubmission(row.id, now))
  return results
}

/**
 * Ops approval of a HELD row (docs/14 §6): the same settlement as a clean validation,
 * on the numbers already recorded. Disclosure was checked at S-02 and cannot be waived here.
 */
export async function approveHeldSubmission(submissionId: string, actor: { kind: 'OPS'; id: string }): Promise<ValidationOutcome> {
  const s = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { state: true, eligibleViews: true, riskScore: true, riskFactors: true },
  })
  if (!s || s.state !== 'HELD') return { outcome: 'skipped', state: s?.state ?? 'MISSING' }
  const settled = await qualifySubmission(
    { submissionId, qualifiedViews: s.eligibleViews, riskScore: s.riskScore ?? 0, riskFactors: s.riskFactors },
    actor,
  )
  await notifyClipQualified(submissionId, settled.toUserOre, s.eligibleViews)
  return { outcome: 'qualified', qualifiedViews: s.eligibleViews, toUserOre: settled.toUserOre, riskScore: s.riskScore ?? 0 }
}
