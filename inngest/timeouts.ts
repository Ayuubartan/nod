/**
 * Timeout jobs — CLAUDE.md rule 4: "Every timed state has a timeout job."
 *
 * Two mechanisms on purpose:
 *   - a per-placement sleep scheduled from the transition event, which fires on time
 *   - a sweep every 10 minutes over `deadlineAt`, which catches anything whose event
 *     was lost (a failed emit, a redeploy mid-sleep, a provider outage)
 *
 * Both call the same idempotent `expire()`, so a placement can never be expired twice
 * and its reservation can never be released twice.
 */

import { prisma } from '@/lib/db'
import { inngest } from '@/lib/events'
import { TIMEOUT_MS } from '@/lib/money/rates'
import { expire, overdue } from '@/lib/state/placement'
import { brandApprove } from '@/lib/state/placement'
import { expire as expireCampaign } from '@/lib/state/campaign'
import { SYSTEM } from '@/lib/state/transition'
import { notifyClaimExpiring } from '@/lib/notify'

/** True if the placement is still in the state whose clock we were waiting on. */
async function stillIn(placementId: string, states: string[]): Promise<boolean> {
  const placement = await prisma.placement.findUnique({
    where: { id: placementId },
    select: { state: true, clockPausedAt: true },
  })
  if (!placement) return false
  if (placement.clockPausedAt) return false
  return states.includes(placement.state)
}

/**
 * P-01/02/03 — the 48-hour claim clock, shared by CLAIMED, UPLOADED and POSITIONED.
 * Sends a reminder at the 12-hour mark (docs/03 Notifications).
 */
export const claimExpiry = inngest.createFunction(
  { id: 'claim-expiry', name: 'P-01 claim expiry' },
  { event: 'placement/claimed' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string

    await step.sleep('until-12h-left', TIMEOUT_MS.claim - 12 * 60 * 60 * 1000)
    const needsReminder = await step.run('reminder', async () => {
      if (!(await stillIn(placementId, ['CLAIMED', 'UPLOADED', 'POSITIONED']))) return false
      await notifyClaimExpiring(placementId)
      return true
    })
    if (!needsReminder) return { skipped: true }

    await step.sleep('final-12h', 12 * 60 * 60 * 1000)
    return step.run('expire', async () => {
      if (!(await stillIn(placementId, ['CLAIMED', 'UPLOADED', 'POSITIONED']))) return { skipped: true }
      await expire(placementId)
      return { expired: true }
    })
  },
)

/** P-05 — the participant has 24 hours to review a generated placement. */
export const participantReviewExpiry = inngest.createFunction(
  { id: 'participant-review-expiry', name: 'P-05 participant review expiry' },
  { event: 'placement/generated' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string
    await step.sleep('review-window', TIMEOUT_MS.participantReview)
    return step.run('expire', async () => {
      if (!(await stillIn(placementId, ['PARTICIPANT_REVIEW']))) return { skipped: true }
      await expire(placementId)
      return { expired: true }
    })
  },
)

/**
 * P-06 — Tier B brand review. Unlike the other timers this does NOT expire the
 * placement: docs/03 says "24h -> auto-APPROVED". A brand that ignores its queue must
 * not cost the participant their work.
 */
export const brandReviewExpiry = inngest.createFunction(
  { id: 'brand-review-expiry', name: 'P-06 brand review auto-approve' },
  { event: 'placement/brand.review' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string
    if (event.data.autoApproved === true) return { skipped: 'tier-a' }

    await step.sleep('review-window', TIMEOUT_MS.brandReview)
    return step.run('auto-approve', async () => {
      if (!(await stillIn(placementId, ['BRAND_REVIEW']))) return { skipped: true }
      await brandApprove(placementId, SYSTEM, new Date(), 'Auto-approved after 24h with no brand response')
      return { autoApproved: true }
    })
  },
)

/** P-07 — 48 hours to publish after approval. */
export const publishExpiry = inngest.createFunction(
  { id: 'publish-expiry', name: 'P-07 publish expiry' },
  { event: 'placement/approved' },
  async ({ event, step }) => {
    const placementId = event.data.placementId as string
    await step.sleep('publish-window', TIMEOUT_MS.approvedToPublish)
    return step.run('expire', async () => {
      if (!(await stillIn(placementId, ['APPROVED']))) return { skipped: true }
      await expire(placementId)
      return { expired: true }
    })
  },
)

/** Campaign funding window — AWAITING_FUNDS expires back to DRAFT after 14 days. */
export const fundingExpiry = inngest.createFunction(
  { id: 'funding-expiry', name: 'Campaign funding expiry' },
  { event: 'campaign/approved' },
  async ({ event, step }) => {
    const campaignId = event.data.campaignId as string
    await step.sleep('funding-window', TIMEOUT_MS.awaitingFunds)
    return step.run('expire', async () => {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { state: true },
      })
      if (campaign?.state !== 'AWAITING_FUNDS') return { skipped: true }
      await expireCampaign(campaignId)
      return { expired: true }
    })
  },
)

/**
 * The safety net. Every 10 minutes, expire anything whose deadline has passed
 * regardless of whether its event ever arrived.
 */
export const timeoutSweep = inngest.createFunction(
  { id: 'timeout-sweep', name: 'Timeout sweep (safety net)' },
  { cron: '*/10 * * * *' },
  async ({ step }) => {
    const due = await step.run('find-overdue', () => overdue())

    let expired = 0
    let autoApproved = 0

    for (const placement of due) {
      if (placement.state === 'BRAND_REVIEW') {
        await step.run(`auto-approve-${placement.id}`, async () => {
          await brandApprove(placement.id, SYSTEM, new Date(), 'Auto-approved by timeout sweep')
        })
        autoApproved += 1
      } else {
        await step.run(`expire-${placement.id}`, async () => {
          await expire(placement.id)
        })
        expired += 1
      }
    }

    return { expired, autoApproved, checked: due.length }
  },
)

/**
 * Campaign period end. Runs hourly rather than as a per-campaign sleep because a
 * campaign's end date can be edited while it is live.
 */
export const campaignPeriodEnd = inngest.createFunction(
  { id: 'campaign-period-end', name: 'Campaign period end' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const due = await step.run('find-due', () =>
      prisma.campaign.findMany({
        where: { state: { in: ['LIVE', 'FILLING'] }, deletedAt: null, endsAt: { lte: new Date() } },
        select: { id: true },
      }),
    )

    for (const campaign of due) {
      await step.run(`expire-${campaign.id}`, async () => {
        await expireCampaign(campaign.id)
      })
    }
    return { expired: due.length }
  },
)
