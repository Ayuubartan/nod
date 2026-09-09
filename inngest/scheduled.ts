/**
 * Scheduled jobs — docs/08 repo structure `inngest/scheduled/`.
 *
 * Token refresh, campaign go-live, the daily payout batch, the monthly follower-floor
 * re-evaluation, fill-threshold alerts, campaign reconciliation, and the GDPR
 * retention jobs from docs/04 and docs/07.
 */

import { prisma } from '@/lib/db'
import { inngest } from '@/lib/events'
import { encrypt, tryDecrypt } from '@/lib/crypto'
import { flag } from '@/lib/flags'
import { providerFor } from '@/lib/integrations/social'
import { syncAccount } from '@/lib/social-sync'
import { LIMITS, TIMEOUT_MS } from '@/lib/money/rates'
import {
  allPlacementsTerminal,
  close,
  dueForGoLive,
  fillPercent,
  goLive,
  reconcile,
  reopen,
} from '@/lib/state/campaign'
import { markQualifiedAsPaid } from '@/lib/state/money'
import { restore, suspendedLongerThan } from '@/lib/state/participant'
import { SYSTEM } from '@/lib/state/transition'
import { notifyBrandCampaignLive, notifyCampaignLive, notifyFillThreshold, notifyOps } from '@/lib/notify'

/** Fridays 18:00 Europe/Stockholm by default — the drop (docs/02 B1). */
export const campaignGoLive = inngest.createFunction(
  { id: 'campaign-go-live', name: 'Campaign go-live' },
  { cron: '*/15 * * * *' },
  async ({ step }) => {
    const ids = await step.run('find-due', () => dueForGoLive())

    for (const campaignId of ids) {
      await step.run(`go-live-${campaignId}`, async () => {
        await goLive(campaignId)
        const eligible = await eligibleParticipants(campaignId)
        await notifyCampaignLive(campaignId, eligible)
        await notifyBrandCampaignLive(campaignId)
      })
    }
    return { wentLive: ids.length }
  },
)

/**
 * Instagram long-lived tokens last 60 days and must be refreshed while still valid;
 * TikTok access tokens last 24 hours and are minted from a 365-day refresh token, so
 * they show up here every night. On failure the account goes DISCONNECTED and open
 * placements pause for up to 72h before falling back to the screenshot tier (edge
 * case 7).
 */
export const tokenRefresh = inngest.createFunction(
  { id: 'token-refresh', name: 'Social token refresh' },
  { cron: '0 3 * * *' },
  async ({ step }) => {
    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const accounts = await step.run('find-expiring', () =>
      prisma.socialAccount.findMany({
        where: {
          deletedAt: null,
          tier: { in: ['CONNECTED_API', 'CONNECTED_SCREENSHOT'] },
          accessToken: { not: null },
          tokenExpiresAt: { lte: soon },
        },
        select: { id: true, platform: true, accessToken: true, refreshToken: true },
      }),
    )

    let refreshed = 0
    let disconnected = 0

    for (const account of accounts) {
      const ok = await step.run(`refresh-${account.id}`, async () => {
        const token = tryDecrypt(account.accessToken)
        if (!token) return false
        try {
          const next = await providerFor(account.platform).refresh(token, tryDecrypt(account.refreshToken))
          await prisma.socialAccount.update({
            where: { id: account.id },
            data: {
              accessToken: encrypt(next.token),
              // TikTok rotates the refresh token on every refresh; Instagram has none.
              refreshToken: next.refreshToken ? encrypt(next.refreshToken) : account.refreshToken,
              tokenExpiresAt: next.expiresAt,
            },
          })
          return true
        } catch {
          await prisma.socialAccount.update({
            where: { id: account.id },
            data: { tier: 'DISCONNECTED', disconnectedAt: new Date() },
          })
          return false
        }
      })
      if (ok) refreshed += 1
      else disconnected += 1
    }

    return { refreshed, disconnected }
  },
)

/**
 * Daily analytics pull — docs/06 sections 1-2. Followers and the 30-day view average
 * for every connected account, appended to `SocialAccountSnapshot` so participants see
 * their history. Runs after the token refresh so nothing here hits an expired token.
 */
export const socialSync = inngest.createFunction(
  { id: 'social-sync', name: 'Social account analytics sync' },
  { cron: '0 5 * * *' },
  async ({ step }) => {
    const accounts = await step.run('find-connected', () =>
      prisma.socialAccount.findMany({
        where: {
          deletedAt: null,
          tier: { in: ['CONNECTED_API', 'CONNECTED_SCREENSHOT', 'BELOW_FLOOR'] },
          accessToken: { not: null },
        },
        select: { id: true },
      }),
    )

    let synced = 0
    let failed = 0
    for (const account of accounts) {
      const result = await step.run(`sync-${account.id}`, () => syncAccount(account.id))
      if (result.ok) synced += 1
      else failed += 1
    }
    return { synced, failed }
  },
)

/**
 * Edge case 7: an account that has been DISCONNECTED for more than 72 hours falls back
 * to the screenshot tier so its open placements can still be verified by ops.
 */
export const disconnectFallback = inngest.createFunction(
  { id: 'disconnect-fallback', name: 'Disconnected account fallback' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - TIMEOUT_MS.tokenDisconnectGrace)

    const stale = await step.run('find-stale', () =>
      prisma.socialAccount.findMany({
        where: { tier: 'DISCONNECTED', deletedAt: null, disconnectedAt: { lte: cutoff } },
        select: { id: true },
      }),
    )

    for (const account of stale) {
      await step.run(`fallback-${account.id}`, () =>
        prisma.socialAccount.update({
          where: { id: account.id },
          data: { tier: 'CONNECTED_SCREENSHOT' },
        }),
      )
    }
    return { fellBack: stale.length }
  },
)

/** Daily payout batch — the pilot exports a CSV that ops pays by hand (docs/06 section 5). */
export const payoutBatch = inngest.createFunction(
  { id: 'payout-batch', name: 'Daily payout batch' },
  { cron: '0 9 * * *' },
  async ({ step }) => {
    await step.run('mark-qualified-paid', () => markQualifiedAsPaid())

    const { payableWallets } = await import('@/lib/state/money')
    const rows = await step.run('find-payable', () => payableWallets())

    if (rows.length > 0) {
      await step.run('alert-ops', () =>
        notifyOps(`${rows.length} wallets ready for payout`, {
          totalOre: rows.reduce((s, r) => s + r.amountOre, 0),
        }),
      )
    }
    return { payable: rows.length }
  },
)

/**
 * Monthly follower-floor re-evaluation — docs/03: "BELOW_FLOOR (<300 followers or <100
 * avg views; re-evaluated monthly)".
 */
export const floorReevaluate = inngest.createFunction(
  { id: 'floor-reevaluate', name: 'Monthly eligibility floor re-evaluation' },
  { cron: '0 4 1 * *' },
  async ({ step }) => {
    const minFollowers = await flag('eligibility.minFollowers')
    const minAvgViews = await flag('eligibility.minAvgViews')

    const accounts = await step.run('load', () =>
      prisma.socialAccount.findMany({
        where: { deletedAt: null, tier: { in: ['CONNECTED_API', 'CONNECTED_SCREENSHOT', 'BELOW_FLOOR'] } },
        select: { id: true, tier: true, followers: true, avgViews30d: true, accountType: true },
      }),
    )

    let promoted = 0
    let demoted = 0

    for (const account of accounts) {
      const belowFloor = account.followers < minFollowers && account.avgViews30d < minAvgViews
      const target = belowFloor
        ? 'BELOW_FLOOR'
        : account.accountType === 'personal'
          ? 'CONNECTED_SCREENSHOT'
          : 'CONNECTED_API'

      if (target === account.tier) continue

      await step.run(`retier-${account.id}`, () =>
        prisma.socialAccount.update({ where: { id: account.id }, data: { tier: target } }),
      )
      if (target === 'BELOW_FLOOR') demoted += 1
      else promoted += 1
    }

    return { promoted, demoted }
  },
)

/** Fill thresholds: email the brand and ping ops at 50%, 90% and 100% (docs/03). */
export const fillThresholds = inngest.createFunction(
  { id: 'fill-thresholds', name: 'Fill threshold alerts' },
  { cron: '*/30 * * * *' },
  async ({ step }) => {
    const live = await step.run('load-live', () =>
      prisma.campaign.findMany({
        where: { state: { in: ['LIVE', 'FILLING'] }, deletedAt: null },
        select: { id: true },
      }),
    )

    let alerts = 0
    for (const campaign of live) {
      const fired = await step.run(`check-${campaign.id}`, async () => {
        const percent = await fillPercent(campaign.id)
        for (const threshold of [100, 90, 50]) {
          if (percent < threshold) continue
          // The audit log is the idempotency record: one alert per threshold, ever.
          const already = await prisma.auditLog.count({
            where: { entity: 'Campaign', entityId: campaign.id, event: `FILL_${threshold}` },
          })
          if (already > 0) continue
          await prisma.auditLog.create({
            data: {
              entity: 'Campaign',
              entityId: campaign.id,
              event: `FILL_${threshold}`,
              actor: 'system',
              payload: { percent },
            },
          })
          await notifyFillThreshold(campaign.id, threshold)
          return true
        }
        return false
      })
      if (fired) alerts += 1
    }

    // 72h with no claims is an ops problem, not a brand problem (docs/03).
    await step.run('no-claims-alert', async () => {
      const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000)
      const stalled = await prisma.campaign.findMany({
        where: { state: 'LIVE', deletedAt: null, liveAt: { lte: cutoff }, placements: { none: {} } },
        select: { id: true, name: true },
      })
      for (const campaign of stalled) {
        await notifyOps(`${campaign.name} has had no claims for 72 hours`, { campaignId: campaign.id })
      }
    })

    return { alerts }
  },
)

/**
 * Campaign reconciliation: an EXHAUSTED or EXPIRED campaign whose placements have all
 * reached a terminal state moves to RECONCILING. Before that, if more than 20% of the
 * budget has been released it reopens once for 24 hours (edge case 1).
 */
export const reconcileCampaigns = inngest.createFunction(
  { id: 'reconcile-campaigns', name: 'Campaign reconciliation' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const candidates = await step.run('load', () =>
      prisma.campaign.findMany({
        where: { state: { in: ['EXHAUSTED', 'EXPIRED', 'PAUSED'] }, deletedAt: null },
        select: { id: true, state: true, reopenedAt: true, endsAt: true },
      }),
    )

    let reopened = 0
    let reconciled = 0

    for (const campaign of candidates) {
      // Only an EXHAUSTED campaign inside its period can reopen; an expired period or a
      // deliberate pause never reopens.
      // step.run serialises its result, so date columns arrive here as ISO strings.
      const canReopen =
        campaign.state === 'EXHAUSTED' &&
        !campaign.reopenedAt &&
        (!campaign.endsAt || new Date(campaign.endsAt) > new Date())

      if (canReopen) {
        const didReopen = await step.run(`reopen-${campaign.id}`, async () => {
          try {
            await reopen(campaign.id)
            return true
          } catch {
            // Guard refused (under the 20% threshold) — normal, not an error.
            return false
          }
        })
        if (didReopen) {
          reopened += 1
          continue
        }
      }

      const done = await step.run(`reconcile-${campaign.id}`, async () => {
        if (!(await allPlacementsTerminal(campaign.id))) return false
        await reconcile(campaign.id)
        return true
      })
      if (done) reconciled += 1
    }

    return { reopened, reconciled }
  },
)

/** A reopened campaign closes its 24-hour window and exhausts again. */
export const closeReopenWindow = inngest.createFunction(
  { id: 'close-reopen-window', name: 'Close the reopen window' },
  { event: 'campaign/reopened' },
  async ({ event, step }) => {
    const campaignId = event.data.campaignId as string
    await step.sleep('reopen-window', LIMITS.reopenWindowMs)
    return step.run('exhaust-again', async () => {
      const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { state: true } })
      if (campaign?.state !== 'FILLING') return { skipped: true }
      const { exhaust } = await import('@/lib/state/campaign')
      await exhaust(campaignId)
      return { exhausted: true }
    })
  },
)

/** RECONCILING -> CLOSED once the 7-day dispute window has passed. */
export const closeCampaigns = inngest.createFunction(
  { id: 'close-campaigns', name: 'Close reconciled campaigns' },
  { cron: '0 5 * * *' },
  async ({ step }) => {
    const due = await step.run('load', () =>
      prisma.campaign.findMany({
        where: { state: 'RECONCILING', deletedAt: null, disputeWindowEndsAt: { lte: new Date() } },
        select: { id: true, brand: { select: { rolloverPreference: true } } },
      }),
    )

    for (const campaign of due) {
      await step.run(`close-${campaign.id}`, async () => {
        const openDisputes = await prisma.dispute.count({
          where: { placement: { campaignId: campaign.id }, state: 'OPEN' },
        })
        if (openDisputes > 0) {
          await notifyOps(`Campaign ${campaign.id} has ${openDisputes} open disputes and cannot close`, {
            campaignId: campaign.id,
          })
          return
        }
        await close(campaign.id, {
          mode: campaign.brand.rolloverPreference === 'rollover' ? 'rollover' : 'refund',
        })
      })
    }
    return { closed: due.length }
  },
)

/** Auto-restore after the 90-day suspension (docs/03 section 3). */
export const restoreSuspended = inngest.createFunction(
  { id: 'restore-suspended', name: 'Restore suspended participants' },
  { cron: '0 6 * * *' },
  async ({ step }) => {
    const ids = await step.run('find', () => suspendedLongerThan(LIMITS.suspensionDays))
    for (const userId of ids) {
      await step.run(`restore-${userId}`, () => restore(userId, 'Suspension period elapsed', SYSTEM))
    }
    return { restored: ids.length }
  },
)

// ---------------------------------------------------------------- retention

/**
 * Retention — docs/04 "Retention", docs/07 section 3.
 *
 * Original images: 90 days after terminal, unless the participant gave training
 * consent, in which case an anonymised copy moves to the training bucket instead.
 * Screenshots: 30 days after the verification decision.
 */
export const retentionSweep = inngest.createFunction(
  { id: 'retention-sweep', name: 'Retention sweep' },
  { cron: '0 2 * * *' },
  async ({ step }) => {
    const now = Date.now()
    const originalsCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000)
    const screenshotCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000)

    const originals = await step.run('purge-originals', async () => {
      const stale = await prisma.placement.findMany({
        where: {
          deletedAt: null,
          originalPath: { not: null },
          updatedAt: { lte: originalsCutoff },
          state: { in: ['PAID', 'REJECTED', 'EXPIRED', 'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND'] },
          user: { trainingConsent: false },
        },
        select: { id: true },
      })
      if (stale.length === 0) return 0
      await prisma.placement.updateMany({
        where: { id: { in: stale.map((p) => p.id) } },
        data: { originalPath: null },
      })
      return stale.length
    })

    const screenshots = await step.run('purge-screenshots', async () => {
      const stale = await prisma.verification.findMany({
        where: { screenshotPath: { not: null }, decidedAt: { lte: screenshotCutoff } },
        select: { id: true },
      })
      if (stale.length === 0) return 0
      await prisma.verification.updateMany({
        where: { id: { in: stale.map((v) => v.id) } },
        data: { screenshotPath: null },
      })
      return stale.length
    })

    return { originals, screenshots }
  },
)

/**
 * GDPR erasure, 30 days after the request — docs/07 section 3.
 * The ledger, the audit log and the BankID subject hash are retained: bookkeeping
 * exemption and re-registration blocking respectively.
 */
export const gdprErasure = inngest.createFunction(
  { id: 'gdpr-erasure', name: 'GDPR erasure' },
  { cron: '0 1 * * *' },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const due = await step.run('find', () =>
      prisma.user.findMany({
        where: { deletionRequestedAt: { lte: cutoff }, state: { not: 'REMOVED' } },
        select: { id: true },
      }),
    )

    for (const user of due) {
      await step.run(`erase-${user.id}`, async () => {
        await prisma.$transaction(async (tx) => {
          await tx.socialAccount.updateMany({
            where: { userId: user.id },
            data: { accessToken: null, refreshToken: null, deletedAt: new Date() },
          })
          await tx.socialAccountSnapshot.updateMany({
            where: { account: { userId: user.id } },
            data: { deletedAt: new Date() },
          })
          await tx.placement.updateMany({
            where: { userId: user.id },
            data: { originalPath: null, postUrl: null },
          })
          await tx.user.update({
            where: { id: user.id },
            data: {
              state: 'REMOVED',
              email: null,
              swishNumber: null,
              city: null,
              ageBracket: null,
              pushSubscription: undefined,
              deletedAt: new Date(),
            },
          })
          // Identity.subjectHash is deliberately kept — it blocks re-registration.
          await tx.auditLog.create({
            data: { entity: 'Participant', entityId: user.id, event: 'GDPR_ERASURE', actor: 'system' },
          })
        })
      })
    }
    return { erased: due.length }
  },
)

/** Idle DRAFT campaigns are deleted after 30 days (docs/03 section 2). */
export const purgeIdleDrafts = inngest.createFunction(
  { id: 'purge-idle-drafts', name: 'Purge idle draft campaigns' },
  { cron: '0 2 * * 1' },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - TIMEOUT_MS.draftIdle)
    const result = await step.run('purge', () =>
      prisma.campaign.updateMany({
        where: { state: 'DRAFT', deletedAt: null, updatedAt: { lte: cutoff } },
        data: { deletedAt: new Date() },
      }),
    )
    return { purged: result.count }
  },
)

// ---------------------------------------------------------------- helpers

/** Participants eligible for a campaign, for the go-live push. */
async function eligibleParticipants(campaignId: string): Promise<string[]> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { cities: true, ageBrackets: true, minFollowers: true, maxFollowers: true, categories: true },
  })

  const users = await prisma.user.findMany({
    where: {
      deletedAt: null,
      state: { in: ['VERIFIED', 'ACTIVE'] },
      ...(campaign.cities.length > 0 ? { city: { in: campaign.cities } } : {}),
      ...(campaign.ageBrackets.length > 0 ? { ageBracket: { in: campaign.ageBrackets } } : {}),
      accounts: {
        some: {
          deletedAt: null,
          tier: { in: ['CONNECTED_API', 'CONNECTED_SCREENSHOT'] },
          followers: {
            gte: campaign.minFollowers,
            ...(campaign.maxFollowers ? { lte: campaign.maxFollowers } : {}),
          },
        },
      },
    },
    select: { id: true },
    take: 5_000,
  })

  return users.map((u) => u.id)
}
