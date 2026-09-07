/**
 * The publish -> hold -> verify -> settle pipeline — docs/09 M3.
 *
 * Post detection (API tier) polls every 2 hours after approval. The hold job schedules
 * verification per content type, with a midpoint re-check for posts and reels, and
 * pulls Story views 30 minutes BEFORE the hold ends, because Instagram Story insights
 * disappear with the Story (docs/06 section 1).
 */

import { prisma } from '@/lib/db'
import { inngest } from '@/lib/events'
import { tryDecrypt } from '@/lib/crypto'
import { socialProvider } from '@/lib/integrations/instagram'
import { perceptualHash } from '@/lib/media'
import { HOLD_MS, LIMITS, TIMEOUT_MS } from '@/lib/money/rates'
import { holdDurationMs, holdEnded, publish, retryGeneration } from '@/lib/state/placement'
import { holdRecheck, verify } from '@/lib/state/verification'
import { markQualifiedAsPaid, payReferralBonusIfDue } from '@/lib/state/money'
import { SYSTEM } from '@/lib/state/transition'
import {
  notifyApprovedPostNow,
  notifyFraudFlag,
  notifyHoldComplete,
  notifyPlacementGenerated,
  notifyQualified,
  notifyRejected,
} from '@/lib/notify'

/**
 * API-tier post detection — docs/06 section 1: poll recent media every 2h for a caption
 * containing the issued disclosure token, or a perceptual hash matching the approved
 * version. Screenshot-tier participants paste the URL instead.
 */
export const detectPost = inngest.createFunction(
  { id: 'detect-post', name: 'P-07 post detection (API tier)' },
  { event: 'placement/approved' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string

    await step.run('notify-post-now', () => notifyApprovedPostNow(placementId))

    // 24 attempts x 2h covers the whole 48-hour publish window.
    for (let attempt = 0; attempt < 24; attempt++) {
      const found = await step.run(`poll-${attempt}`, async () => {
        const placement = await prisma.placement.findUnique({
          where: { id: placementId },
          select: {
            state: true,
            disclosureToken: true,
            disclosureTextIssued: true,
            originalHash: true,
            publishedAt: true,
            account: { select: { tier: true, accessToken: true, platformUserId: true } },
          },
        })

        if (!placement || placement.state !== 'APPROVED') return 'stop'
        if (placement.account.tier !== 'CONNECTED_API') return 'skip'

        const token = tryDecrypt(placement.account.accessToken)
        if (!token) return 'skip'

        const provider = socialProvider()
        const since = new Date(Date.now() - TIMEOUT_MS.approvedToPublish)
        const media = await provider.recentMedia(token, since)

        for (const item of media) {
          const captionMatch =
            placement.disclosureTextIssued != null &&
            item.caption != null &&
            item.caption.toLowerCase().includes(placement.disclosureTextIssued.toLowerCase().slice(0, 24))

          const hashMatch =
            item.perceptualHash != null &&
            placement.originalHash != null &&
            item.perceptualHash === placement.originalHash

          if (captionMatch || hashMatch) {
            await publish(
              placementId,
              { postUrl: item.permalink ?? '', postPlatformId: item.id },
              SYSTEM,
            )
            return 'found'
          }
        }
        return 'not-yet'
      })

      if (found === 'stop' || found === 'found') return { detected: found === 'found' }
      if (found === 'skip') return { skipped: 'not-api-tier' }

      await step.sleep(`wait-${attempt}`, 2 * 60 * 60 * 1000)
    }

    return { detected: false }
  },
)

/**
 * The hold. Story: 24h, and views are pulled at hold end minus 30 minutes.
 * Reel/Post: 7d, with a midpoint re-check that the post still exists (edge case 5).
 */
export const holdAndVerify = inngest.createFunction(
  { id: 'hold-and-verify', name: 'P-08 hold, then P-09 verification' },
  { event: 'placement/published' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string

    const placement = await step.run('load', () =>
      prisma.placement.findUniqueOrThrow({
        where: { id: placementId },
        select: { contentType: true, holdEndsAt: true },
      }),
    )

    const holdMs = holdDurationMs(placement.contentType)
    const isStory = holdMs === HOLD_MS.story

    // Midpoint re-check for the long holds.
    if (!isStory) {
      await step.sleep('to-midpoint', holdMs / 2)
      const midpoint = await step.run('midpoint-recheck', async () => {
        const stillLive = await isPostStillLive(placementId)
        return holdRecheck(placementId, stillLive)
      })
      if (midpoint === 'rejected') {
        await step.run('notify-deleted', () => notifyRejected(placementId, 'DELETED_EARLY'))
        return { rejected: 'DELETED_EARLY' }
      }
      await step.sleep('to-hold-end', holdMs / 2 - 30 * 60 * 1000)
    } else {
      // Pull Story insights while the Story is still alive.
      await step.sleep('to-hold-end-minus-30', holdMs - 30 * 60 * 1000)
    }

    const snapshot = await step.run('pull-views', () => pullViews(placementId))

    await step.run('hold-ended', async () => {
      await holdEnded(placementId)
      await notifyHoldComplete()
    })

    const outcome = await step.run('verify', () =>
      verify({
        placementId,
        observedPlatformUserId: snapshot.observedPlatformUserId,
        caption: snapshot.caption,
        hasPaidPartnershipLabel: snapshot.hasPaidPartnershipLabel,
        publishedHash: snapshot.publishedHash,
        views: snapshot.views,
        viewsSource: snapshot.source,
        engagements: snapshot.engagements,
        stillLive: snapshot.stillLive,
      }),
    )

    if (outcome.decision === 'QUALIFIED') {
      await step.run('pay', async () => {
        await markQualifiedAsPaid()
        await notifyQualified(placementId, outcome.toUserOre)
      })
    } else if (outcome.decision === 'FLAGGED') {
      await step.run('flag', () => notifyFraudFlag(placementId, outcome.assessment.score))
    } else if (outcome.decision === 'REJECTED') {
      await step.run('notify-rejected', () => notifyRejected(placementId, outcome.reason))
    }

    return outcome
  },
)

/** Disclosure fix window — one re-verify, 12 hours (docs/03 edge case 3). */
export const disclosureFixWindow = inngest.createFunction(
  { id: 'disclosure-fix-window', name: 'Disclosure fix window' },
  { event: 'placement/disclosure.fix.window' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string
    await step.sleep('fix-window', TIMEOUT_MS.disclosureFix)

    return step.run('re-verify', async () => {
      const placement = await prisma.placement.findUnique({
        where: { id: placementId },
        select: { state: true, fixWindowEndsAt: true },
      })
      // Only a placement the participant pulled back into PUBLISHED can be re-verified.
      if (!placement || placement.state !== 'PUBLISHED') return { skipped: true }

      const snapshot = await pullViews(placementId)
      await prisma.verification.update({ where: { placementId }, data: { attempt: { increment: 1 } } })
      await holdEnded(placementId)

      const outcome = await verify({
        placementId,
        observedPlatformUserId: snapshot.observedPlatformUserId,
        caption: snapshot.caption,
        hasPaidPartnershipLabel: snapshot.hasPaidPartnershipLabel,
        publishedHash: snapshot.publishedHash,
        views: snapshot.views,
        viewsSource: snapshot.source,
        stillLive: false,
      })
      return outcome
    })
  },
)

/** Generation retries: twice, then it goes to ops (docs/03 P-04). */
export const generationRetry = inngest.createFunction(
  { id: 'generation-retry', name: 'P-04 generation retry' },
  { event: 'placement/generation.failed' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string

    const attempts = await step.run('count-attempts', () =>
      prisma.auditLog.count({ where: { entity: 'Placement', entityId: placementId, event: 'GENERATION_FAIL' } }),
    )

    if (attempts > LIMITS.maxGenerationRetries) {
      await step.run('escalate', () =>
        import('@/lib/notify').then((m) =>
          m.notifyOps(`Generation failed ${attempts} times for placement ${placementId}`, { placementId }),
        ),
      )
      return { escalated: true }
    }

    await step.sleep('backoff', 5 * 60 * 1000)
    await step.run('retry', () => retryGeneration(placementId))
    // Re-entering GENERATING is not a render. Ask the engine again; a second failure
    // comes back through this same function with attempts + 1.
    const outcome = await step.run('render', () => import('@/lib/render').then((m) => m.renderPlacement(placementId)))
    return { retried: attempts, outcome }
  },
)

/** Ops uploaded a generated version — tell the participant it is ready to review. */
export const generatedNotification = inngest.createFunction(
  { id: 'generated-notification', name: 'P-05 generated notification' },
  { event: 'placement/generated' },
  async ({ event, step }) => {
    await step.run('notify', () => notifyPlacementGenerated(event.data.placementId as string))
    return { notified: true }
  },
)

/** Referral bonus on the referred user's first QUALIFIED placement (docs/05). */
export const referralBonusJob = inngest.createFunction(
  { id: 'referral-bonus', name: 'Referral bonus' },
  { event: 'placement/qualified' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string
    return step.run('pay-bonus', async () => {
      const placement = await prisma.placement.findUniqueOrThrow({
        where: { id: placementId },
        select: { userId: true },
      })
      const paid = await payReferralBonusIfDue(placement.userId)
      return { paid }
    })
  },
)

// ---------------------------------------------------------------- helpers

type ViewSnapshotResult = {
  observedPlatformUserId: string | null
  caption: string | null
  hasPaidPartnershipLabel: boolean | null
  publishedHash: string | null
  views: number | null
  source: 'api' | 'screenshot'
  engagements: number | null
  stillLive: boolean
}

/**
 * Pulls the numbers verification needs. API tier reads insights; screenshot tier
 * returns null views, which sends the placement to the ops verification queue.
 */
async function pullViews(placementId: string): Promise<ViewSnapshotResult> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: {
      postPlatformId: true,
      account: { select: { tier: true, accessToken: true, platformUserId: true } },
    },
  })

  if (placement.account.tier !== 'CONNECTED_API' || !placement.postPlatformId) {
    return {
      observedPlatformUserId: null,
      caption: null,
      hasPaidPartnershipLabel: null,
      publishedHash: null,
      views: null,
      source: 'screenshot',
      engagements: null,
      stillLive: true,
    }
  }

  const token = tryDecrypt(placement.account.accessToken)
  if (!token) {
    return {
      observedPlatformUserId: null,
      caption: null,
      hasPaidPartnershipLabel: null,
      publishedHash: null,
      views: null,
      source: 'screenshot',
      engagements: null,
      stillLive: true,
    }
  }

  const provider = socialProvider()

  try {
    const { views } = await provider.insights(token, placement.postPlatformId)
    const media = await provider.recentMedia(token, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    const item = media.find((m) => m.id === placement.postPlatformId)

    return {
      observedPlatformUserId: placement.account.platformUserId,
      caption: item?.caption ?? null,
      hasPaidPartnershipLabel: item?.isPaidPartnership ?? null,
      publishedHash: item?.perceptualHash ?? null,
      views,
      source: 'api',
      engagements: null,
      stillLive: item !== undefined,
    }
  } catch {
    // The media is gone -> DELETED_EARLY is decided by isPostStillLive, not here.
    return {
      observedPlatformUserId: placement.account.platformUserId,
      caption: null,
      hasPaidPartnershipLabel: null,
      publishedHash: null,
      views: null,
      source: 'api',
      engagements: null,
      stillLive: false,
    }
  }
}

/** Whether the post is still on the account. Screenshot tier is trusted until hold end. */
async function isPostStillLive(placementId: string): Promise<boolean> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: {
      postPlatformId: true,
      account: { select: { tier: true, accessToken: true } },
    },
  })

  if (placement.account.tier !== 'CONNECTED_API' || !placement.postPlatformId) return true

  const token = tryDecrypt(placement.account.accessToken)
  if (!token) return true

  try {
    const media = await socialProvider().recentMedia(token, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    return media.some((m) => m.id === placement.postPlatformId)
  } catch {
    // An API failure must not cost a participant their payout — treat as still live and
    // let the hold-end pull make the call.
    return true
  }
}

export { perceptualHash }
