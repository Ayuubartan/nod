/**
 * S-02 ownership + caption verification for clip submissions — docs/14 §3.
 *
 * Order of checks is fixed and each failure is terminal for that reason:
 *   1. the post exists in the *creator's own* media (ownership) — else NOT_OWNER
 *   2. it was published inside the campaign window — else OUTSIDE_WINDOW
 *   3. the caption carries the disclosure + required tags — else a 12 h fix window,
 *      and NO_DISCLOSURE once that window has closed (CLAUDE.md rule 5)
 *
 * Provider trouble (rate limit, outage, missing token) never rejects a creator's post;
 * it comes back as `retry` and the Inngest job waits and calls again.
 */

import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { ProviderError, type PostMetrics } from '@/lib/integrations/types'
import { providerFor } from '@/lib/integrations/social'
import { freshToken } from '@/lib/social-sync'
import { checkCaption, insidePublishWindow, TOKEN_PAUSE_MS } from '@/lib/clips/rules'
import {
  needsDisclosureFix,
  pauseTrackingForAccount,
  rejectSubmission,
  verificationPassed,
} from '@/lib/state/submission'

export type VerifyOutcome =
  | { outcome: 'tracking' }
  /** `entered` is true the first time the row moves into FIX_DISCLOSURE, false on a re-check inside the window. */
  | { outcome: 'fix_disclosure'; entered: boolean; missingHashtags: string[]; missingMentions: string[]; disclosureOk: boolean }
  | { outcome: 'rejected'; reason: 'NOT_OWNER' | 'OUTSIDE_WINDOW' | 'NO_DISCLOSURE' }
  | { outcome: 'retry'; why: 'no_token' | 'rate_limited' | 'transient' | 'unauthorized'; retryAfterMs?: number }
  | { outcome: 'skipped'; state: string }

/** Default wait before the verify job asks the provider again. */
export const VERIFY_RETRY_MS = 5 * 60 * 1000

const VERIFIABLE_STATES = ['RECEIVED', 'FIX_DISCLOSURE'] as const

export async function verifySubmission(submissionId: string, now: Date = new Date()): Promise<VerifyOutcome> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      state: true,
      platform: true,
      postId: true,
      fixWindowEndsAt: true,
      campaign: {
        select: {
          liveAt: true,
          startsAt: true,
          endsAt: true,
          disclosureText: true,
          requiredHashtags: true,
          requiredMentions: true,
          brand: { select: { name: true } },
        },
      },
      account: {
        select: { id: true, platform: true, accessToken: true, refreshToken: true, tokenExpiresAt: true },
      },
    },
  })

  if (!submission || !(VERIFIABLE_STATES as readonly string[]).includes(submission.state)) {
    return { outcome: 'skipped', state: submission?.state ?? 'MISSING' }
  }

  const token = await freshToken(submission.account)
  if (!token) return { outcome: 'retry', why: 'no_token', retryAfterMs: VERIFY_RETRY_MS }

  let post: PostMetrics
  try {
    // DECISION: the lookup goes through the *creator's* token, so "found" is the
    // ownership proof itself — no separate author-id comparison is needed.
    const lookup = await providerFor(submission.platform).resolveOwnPost(token, submission.postId)
    if (lookup.status === 'not_found') {
      await rejectSubmission({ submissionId, reason: 'NOT_OWNER' })
      return { outcome: 'rejected', reason: 'NOT_OWNER' }
    }
    post = lookup.post
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    log.warn('clip verify provider error', { submissionId, kind: error.kind, error: error.message })
    if (error.kind === 'unauthorized') {
      // A dead token affects every submission on the account, not only this one.
      await pauseTrackingForAccount(submission.account.id, TOKEN_PAUSE_MS, now)
      return { outcome: 'retry', why: 'unauthorized', retryAfterMs: TOKEN_PAUSE_MS }
    }
    return { outcome: 'retry', why: error.kind, retryAfterMs: error.retryAfterMs ?? VERIFY_RETRY_MS }
  }

  if (!insidePublishWindow(post.publishedAt, submission.campaign)) {
    await rejectSubmission({ submissionId, reason: 'OUTSIDE_WINDOW' })
    return { outcome: 'rejected', reason: 'OUTSIDE_WINDOW' }
  }

  const caption = checkCaption(
    post.caption,
    {
      disclosureText: submission.campaign.disclosureText.replace('{brand}', submission.campaign.brand.name),
      requiredHashtags: submission.campaign.requiredHashtags,
      requiredMentions: submission.campaign.requiredMentions,
    },
    post.isPaidPartnership,
  )

  if (caption.ok) {
    await verificationPassed(
      {
        submissionId,
        providerMediaId: post.providerMediaId,
        caption: post.caption,
        publishedAt: post.publishedAt,
        initial: {
          views: post.views,
          likes: post.likes ?? undefined,
          comments: post.comments ?? undefined,
          shares: post.shares ?? undefined,
          observedAt: now,
        },
      },
      undefined,
      now,
    )
    return { outcome: 'tracking' }
  }

  const detail = { missingHashtags: caption.missingHashtags, missingMentions: caption.missingMentions, disclosureOk: caption.disclosureOk }
  const windowOpen =
    submission.state === 'FIX_DISCLOSURE' && submission.fixWindowEndsAt != null && submission.fixWindowEndsAt.getTime() > now.getTime()

  if (submission.state === 'RECEIVED') {
    await needsDisclosureFix(submissionId, detail, undefined, now)
    return { outcome: 'fix_disclosure', entered: true, ...detail }
  }
  if (windowOpen) {
    // Re-checked early (creator pressed "I fixed it") but still missing; window keeps running.
    return { outcome: 'fix_disclosure', entered: false, ...detail }
  }

  await rejectSubmission({ submissionId, reason: 'NO_DISCLOSURE', note: describeMissing(detail) })
  return { outcome: 'rejected', reason: 'NO_DISCLOSURE' }
}

function describeMissing(d: { missingHashtags: string[]; missingMentions: string[]; disclosureOk: boolean }): string {
  const parts: string[] = []
  if (!d.disclosureOk) parts.push('disclosure')
  if (d.missingHashtags.length) parts.push(`hashtags: ${d.missingHashtags.join(', ')}`)
  if (d.missingMentions.length) parts.push(`mentions: ${d.missingMentions.join(', ')}`)
  return `Missing ${parts.join('; ')}`
}
