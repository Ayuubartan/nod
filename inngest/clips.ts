/**
 * Clip campaign jobs — docs/14 §3-6: verification (S-02), tracking (S-03), validation and
 * settlement (S-04..S-06) plus the ops sweeps that catch whatever a lost event left behind.
 *
 * Every function is idempotent: the lib/clips entry points read the row's current state
 * and return `skipped` for anything that already moved on, snapshots dedupe per bucket
 * and settlement is keyed by externalRef, so a redelivered event or an overlapping retry
 * changes nothing.
 */

import { RetryAfterError } from 'inngest'
import { prisma } from '@/lib/db'
import { inngest } from '@/lib/events'
import { TIMEOUT_MS } from '@/lib/money/rates'
import { verifySubmission, VERIFY_RETRY_MS, type VerifyOutcome } from '@/lib/clips/verify'
import {
  planTrackingBatches,
  trackBatch,
  TrackingRateLimited,
  validateSubmission,
  VALIDATE_RETRY_MS,
  type TrackBatch,
  type ValidationOutcome,
} from '@/lib/clips/tracking'
import { rejectSubmission, staleReceived, validationsDue } from '@/lib/state/submission'
import { notifyClipFixDisclosure, notifyClipRejected, notifyClipTracking, notifyOps } from '@/lib/notify'

/** How many times the verify job asks the provider before parking the row for ops. */
const VERIFY_ATTEMPTS = 12
/** Provider retries allowed at the fix-window deadline before the row is rejected. */
const FINAL_CHECK_ATTEMPTS = 3
/** Rows one validation run settles before leaving the rest for the next tick. */
const VALIDATIONS_PER_RUN = 200
/** Provider retries per validation run before the row waits for the next cron tick. */
const VALIDATE_ATTEMPTS = 3
/** HELD rows older than this are re-surfaced to ops every morning. */
const HELD_REMINDER_MS = 7 * 24 * 60 * 60 * 1000

/** Inngest step.sleep wants whole seconds or a duration string; cap a single wait at an hour. */
const sleepMs = (ms: number | undefined) => Math.min(Math.max(ms ?? VERIFY_RETRY_MS, 30_000), 60 * 60 * 1000)

/**
 * S-02 ownership + caption verification, started by `submission/received`. Provider
 * trouble waits and tries again; after VERIFY_ATTEMPTS the row stays RECEIVED and the
 * stale-received sweep (build step C) surfaces it to ops.
 */
export const submissionVerify = inngest.createFunction(
  { id: 'submission-verify', name: 'S-02 clip ownership verification', concurrency: { limit: 10 } },
  { event: 'submission/received' },
  async ({ event, step }) => {
    const submissionId = event.data.submissionId as string
    let last: VerifyOutcome | null = null

    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
      last = await step.run(`verify-${attempt}`, () => verifySubmission(submissionId))
      if (last.outcome !== 'retry') break
      await step.sleep(`retry-wait-${attempt}`, sleepMs(last.retryAfterMs))
    }
    const final = last
    if (final) await step.run('notify', () => notifyVerifyOutcome(submissionId, final))
    return last
  },
)

/**
 * 12 h disclosure fix window (docs/14 D6). One final re-check when it closes: the
 * caption either carries the disclosure now (→ TRACKING) or the submission is rejected
 * NO_DISCLOSURE. Rule 5: there is no third outcome.
 */
export const submissionFixWindow = inngest.createFunction(
  { id: 'submission-fix-window', name: 'S-02 clip disclosure fix window' },
  { event: 'submission/disclosure.fix.window' },
  async ({ event, step }) => {
    const submissionId = event.data.submissionId as string
    await step.sleep('fix-window', TIMEOUT_MS.disclosureFix)

    let last: VerifyOutcome | null = null
    for (let attempt = 0; attempt < FINAL_CHECK_ATTEMPTS; attempt++) {
      last = await step.run(`final-check-${attempt}`, async () => {
        const submission = await prisma.submission.findUnique({ where: { id: submissionId }, select: { state: true } })
        if (!submission || submission.state !== 'FIX_DISCLOSURE') {
          return { outcome: 'skipped', state: submission?.state ?? 'MISSING' } satisfies VerifyOutcome
        }
        return verifySubmission(submissionId)
      })
      if (last.outcome !== 'retry') {
        const final = last
        await step.run('notify', () => notifyVerifyOutcome(submissionId, final))
        return last
      }
      await step.sleep(`final-retry-wait-${attempt}`, sleepMs(last.retryAfterMs))
    }

    // DECISION: the provider would not answer at the deadline. The last thing NOD saw
    // was a caption without the disclosure, the window has closed and the reservation
    // cannot be held open indefinitely, so the row is rejected on that evidence. The
    // note records why, and a new clip can always be submitted.
    return step.run('reject-unverifiable', async () => {
      const submission = await prisma.submission.findUnique({ where: { id: submissionId }, select: { state: true } })
      if (submission?.state !== 'FIX_DISCLOSURE') return { outcome: 'skipped', state: submission?.state ?? 'MISSING' }
      await rejectSubmission({
        submissionId,
        reason: 'NO_DISCLOSURE',
        note: `Fix window closed; provider unavailable (${last?.outcome === 'retry' ? last.why : 'unknown'})`,
      })
      await notifyClipRejected(submissionId, 'NO_DISCLOSURE')
      return { outcome: 'rejected', reason: 'NO_DISCLOSURE', providerUnavailable: true }
    })
  },
)

/**
 * Push for the terminal verify outcomes. The fix-disclosure push goes out once, when
 * the row enters FIX_DISCLOSURE; a later recheck that still fails is the participant's
 * own action and returns the missing items to the UI directly.
 */
async function notifyVerifyOutcome(submissionId: string, outcome: VerifyOutcome): Promise<void> {
  if (outcome.outcome === 'tracking') await notifyClipTracking(submissionId)
  else if (outcome.outcome === 'rejected') await notifyClipRejected(submissionId, outcome.reason)
  else if (outcome.outcome === 'fix_disclosure' && outcome.entered) {
    await notifyClipFixDisclosure(submissionId, {
      missingHashtags: outcome.missingHashtags,
      missingMentions: outcome.missingMentions,
      disclosureOk: outcome.disclosureOk,
    })
  }
}

// ---------------------------------------------------------------- S-03 tracking

/**
 * Every five minutes: select due rows, group them per (platform, account) and fan one
 * event out per batch. The platform workers below do the provider calls, so a slow or
 * rate-limited TikTok never delays Instagram and vice versa.
 */
export const submissionTrackScheduler = inngest.createFunction(
  { id: 'submission-track-scheduler', name: 'S-03 clip tracking scheduler', concurrency: { limit: 1 } },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const batches = await step.run('plan', () => planTrackingBatches())
    if (batches.length > 0) {
      await step.sendEvent(
        'fan-out',
        batches.map((batch) => ({ name: 'submission/track.batch' as const, data: batch })),
      )
    }
    return { batches: batches.length, submissions: batches.reduce((n, b) => n + b.submissionIds.length, 0) }
  },
)

/**
 * One worker per platform (docs/14 §4). A provider rate limit becomes RetryAfterError so
 * Inngest parks this run for the window the provider asked for instead of hammering it;
 * the throttle keeps the steady-state request rate under the app quota.
 */
function trackWorker(platform: TrackBatch['platform'], throttlePerMinute: number) {
  const slug = platform.toLowerCase()
  return inngest.createFunction(
    {
      id: `submission-track-${slug}`,
      name: `S-03 clip tracking (${platform})`,
      concurrency: { limit: 5 },
      throttle: { limit: throttlePerMinute, period: '1m' },
      retries: 5,
    },
    { event: 'submission/track.batch', if: `event.data.platform == '${platform}'` },
    async ({ event, step }) => {
      const batch = event.data as TrackBatch
      return step.run('track', async () => {
        try {
          return await trackBatch(batch)
        } catch (error) {
          if (error instanceof TrackingRateLimited) {
            throw new RetryAfterError(error.message, Math.max(error.retryAfterMs, 30_000))
          }
          throw error
        }
      })
    },
  )
}

export const submissionTrackTiktok = trackWorker('TIKTOK', 200)
export const submissionTrackInstagram = trackWorker('INSTAGRAM', 100)

// ---------------------------------------------------------------- S-04..S-06 validation

/**
 * Every ten minutes: rows whose window closed get the final pull, the fraud call and
 * settlement. Provider trouble retries a few times inside the run and otherwise waits
 * for the next tick; a row already moved to VALIDATING by an earlier failed run is
 * picked up again here until it settles.
 */
export const submissionValidate = inngest.createFunction(
  { id: 'submission-validate', name: 'S-04 clip validation and settlement', concurrency: { limit: 1 } },
  { cron: '*/10 * * * *' },
  async ({ step }) => {
    const due = await step.run('find-due', async () => {
      const [tracking, validating] = await Promise.all([
        validationsDue(),
        prisma.submission.findMany({ where: { state: 'VALIDATING', deletedAt: null }, select: { id: true }, take: VALIDATIONS_PER_RUN }),
      ])
      const ids = [...new Set([...validating, ...tracking].map((r) => r.id))]
      return ids.slice(0, VALIDATIONS_PER_RUN)
    })

    const tally = { qualified: 0, held: 0, rejected: 0, retry: 0, skipped: 0 }
    for (const submissionId of due) {
      let last: ValidationOutcome | null = null
      for (let attempt = 0; attempt < VALIDATE_ATTEMPTS; attempt++) {
        last = await step.run(`validate-${submissionId}-${attempt}`, () => validateSubmission(submissionId))
        if (last.outcome !== 'retry') break
        if (attempt + 1 < VALIDATE_ATTEMPTS) {
          await step.sleep(`validate-wait-${submissionId}-${attempt}`, sleepMs(last.retryAfterMs ?? VALIDATE_RETRY_MS))
        }
      }
      if (last) tally[last.outcome] += 1
    }
    return { due: due.length, ...tally }
  },
)

// ---------------------------------------------------------------- ops sweeps

/** RECEIVED rows the verify job never resolved within 24 h: ops decides, nothing auto-fails. */
export const submissionStaleReceived = inngest.createFunction(
  { id: 'submission-stale-received', name: 'S-02 stale received sweep' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const ids = await step.run('find-stale', async () => (await staleReceived()).map((r) => r.id))
    if (ids.length > 0) {
      await step.run('alert-ops', () => notifyOps(`${ids.length} clip submission(s) unverified for 24 h`, { submissionIds: ids }))
    }
    return { stale: ids.length }
  },
)

/** HELD rows waiting on ops for more than a week: the reservation stays locked until someone decides. */
export const submissionHeldReminder = inngest.createFunction(
  { id: 'submission-held-reminder', name: 'S-05 held submissions reminder' },
  { cron: '0 8 * * *' },
  async ({ step }) => {
    const ids = await step.run('find-held', async () => {
      const rows = await prisma.submission.findMany({
        // A HELD row is not written again until ops decides, so updatedAt is the hold time.
        where: { state: 'HELD', deletedAt: null, updatedAt: { lte: new Date(Date.now() - HELD_REMINDER_MS) } },
        select: { id: true },
      })
      return rows.map((r) => r.id)
    })
    if (ids.length > 0) {
      await step.run('alert-ops', () => notifyOps(`${ids.length} clip submission(s) held for review > 7 days`, { submissionIds: ids }))
    }
    return { held: ids.length }
  },
)
