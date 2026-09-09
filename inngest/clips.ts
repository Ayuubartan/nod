/**
 * Clip campaign jobs — docs/14 §3 (verification). Tracking, validation and settlement
 * jobs join this module in the next build step.
 *
 * Both functions are idempotent: `verifySubmission` reads the row's current state and
 * returns `skipped` for anything already past RECEIVED / FIX_DISCLOSURE, so a redelivered
 * event or an overlapping retry changes nothing.
 */

import { prisma } from '@/lib/db'
import { inngest } from '@/lib/events'
import { TIMEOUT_MS } from '@/lib/money/rates'
import { verifySubmission, VERIFY_RETRY_MS, type VerifyOutcome } from '@/lib/clips/verify'
import { rejectSubmission } from '@/lib/state/submission'

/** How many times the verify job asks the provider before parking the row for ops. */
const VERIFY_ATTEMPTS = 12
/** Provider retries allowed at the fix-window deadline before the row is rejected. */
const FINAL_CHECK_ATTEMPTS = 3

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
      if (last.outcome !== 'retry') return last
      await step.sleep(`retry-wait-${attempt}`, sleepMs(last.retryAfterMs))
    }
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
      if (last.outcome !== 'retry') return last
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
      return { outcome: 'rejected', reason: 'NO_DISCLOSURE', providerUnavailable: true }
    })
  },
)
