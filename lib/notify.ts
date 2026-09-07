/**
 * Notifications — implements the matrix in docs/03 exactly.
 *
 * | Event                | Participant | Brand           | Ops   |
 * | Campaign live        | push        | email           | —     |
 * | Claim expiring 12h   | push        | —               | —     |
 * | Placement generated  | push        | —               | —     |
 * | Brand review needed  | —           | email + badge   | —     |
 * | Approved — post now  | push        | —               | —     |
 * | Hold complete        | silent      | —               | —     |
 * | Qualified + paid     | push + card | dashboard live  | —     |
 * | Rejected             | push        | —               | log   |
 * | Fraud flag           | silent      | —               | queue |
 * | Fill 50/90/100%      | —           | email           | Slack |
 * | Final report         | —           | email + PDF     | —     |
 *
 * "Silent" rows are deliberately no-ops with a comment, so the matrix is auditable
 * against this file rather than against an absence of code.
 */

import webpush from 'web-push'
import { BRAND, HELLO_EMAIL } from './brand'
import { prisma } from './db'
import { log } from './logger'
import { flag } from './flags'
import { tryDecrypt } from './crypto'
import { normaliseSwishNumber } from './integrations/swish'
import { sendSms, type SmsKind } from './integrations/sms'
import { formatKrDown } from './money/calc'
import type { Locale } from './i18n/config'
import sv from './i18n/sv.json'
import en from './i18n/en.json'
import {
  sendBrandReviewNeeded,
  sendCampaignLiveToBrand,
  sendFillThreshold,
} from './email'

const messages = { sv, en } as const

/** Reads a dotted key out of the message bundle, applying {placeholders}. */
function t(locale: Locale, path: string, vars: Record<string, string | number> = {}): string {
  const raw = path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return (acc as Record<string, unknown>)[key]
    return undefined
  }, messages[locale])

  let text = typeof raw === 'string' ? raw : path
  for (const [key, value] of Object.entries(vars)) {
    text = text.replace(`{${key}}`, String(value))
  }
  return text
}

let vapidConfigured = false

function configureVapid(): boolean {
  if (vapidConfigured) return true
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return false
  webpush.setVapidDetails(`mailto:${HELLO_EMAIL}`, publicKey, privateKey)
  vapidConfigured = true
  return true
}

/** Everything "sent" while running without VAPID keys — asserted by the matrix tests. */
export const sentPushes: Array<{ userId: string; title: string; body: string; url?: string }> = []

export function clearSentPushes(): void {
  sentPushes.length = 0
}

/**
 * Web push, with an SMS fallback for the three notifications docs/06 section 7 allows.
 *
 * `smsKind` is what opts a notification into the fallback. Passing it does not mean an
 * SMS is sent: one goes only when push is genuinely unavailable for that participant,
 * the flag is on, and they opted in. Nobody is billed twice for one notification.
 */
export async function push(
  userId: string,
  args: { title: string; body: string; url?: string; smsKind?: SmsKind },
): Promise<void> {
  const { smsKind, ...payload } = args
  sentPushes.push({ userId, ...payload })

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pushSubscription: true, smsOptIn: true, swishNumber: true },
  })

  const pushDelivered = await (async (): Promise<boolean> => {
    if (!user?.pushSubscription || !configureVapid()) return false
    try {
      await webpush.sendNotification(
        user.pushSubscription as unknown as webpush.PushSubscription,
        JSON.stringify(payload),
      )
      return true
    } catch (error) {
      // A revoked subscription is normal: drop it rather than retrying forever, and let
      // the SMS fallback cover this one.
      const status = (error as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        await prisma.user.update({ where: { id: userId }, data: { pushSubscription: undefined } })
      }
      return false
    }
  })()

  if (pushDelivered || !smsKind || !user?.smsOptIn) return

  // Costs money, so it is flag-gated (docs/06 section 7).
  if (!(await flag('notify.smsFallbackEnabled'))) return

  // The participant's mobile number is the Swish number they gave for payouts; there is
  // no second phone field, and asking for one twice would be worse.
  const number = tryDecrypt(user.swishNumber)
  const normalised = number ? normaliseSwishNumber(number) : null
  if (!normalised) return

  await sendSms(smsKind, normalised, `${payload.title}: ${payload.body}`)
}

async function localeOf(userId: string): Promise<Locale> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { locale: true } })
  return user?.locale === 'en' ? 'en' : 'sv'
}

// ---------------------------------------------------------------- participant

/** Campaign live -> push to eligible participants. */
export async function notifyCampaignLive(campaignId: string, userIds: string[]): Promise<void> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { brand: { select: { name: true } } },
  })

  for (const userId of userIds) {
    const locale = await localeOf(userId)
    await push(userId, {
      title: t(locale, 'notify.campaignLive.title'),
      body: t(locale, 'notify.campaignLive.body', { brand: campaign.brand.name }),
      url: `/campaigns/${campaignId}`,
      smsKind: 'campaignLive',
    })
  }
}

export async function notifyClaimExpiring(placementId: string): Promise<void> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { userId: true, campaign: { select: { brand: { select: { name: true } } } } },
  })
  const locale = await localeOf(placement.userId)
  await push(placement.userId, {
    title: t(locale, 'notify.claimExpiring.title'),
    body: t(locale, 'notify.claimExpiring.body', { brand: placement.campaign.brand.name }),
    url: `/placements/${placementId}`,
    smsKind: 'claimExpiring',
  })
}

export async function notifyPlacementGenerated(placementId: string): Promise<void> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { userId: true },
  })
  const locale = await localeOf(placement.userId)
  await push(placement.userId, {
    title: t(locale, 'notify.generated.title'),
    body: t(locale, 'notify.generated.body'),
    url: `/placements/${placementId}/review`,
  })
}

export async function notifyApprovedPostNow(placementId: string): Promise<void> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { userId: true },
  })
  const locale = await localeOf(placement.userId)
  await push(placement.userId, {
    title: t(locale, 'notify.approvedPostNow.title'),
    body: t(locale, 'notify.approvedPostNow.body'),
    url: `/placements/${placementId}/post`,
    smsKind: 'approvedPostNow',
  })
}

/**
 * Hold complete is SILENT for the participant by design (docs/03): nothing is decided
 * yet, and a notification at that point would only create anxiety about a post they
 * must not delete.
 */
export async function notifyHoldComplete(): Promise<void> {
  // Intentionally no notification.
}

export async function notifyQualified(placementId: string, amountOre: number): Promise<void> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { userId: true, campaign: { select: { brand: { select: { name: true } } } } },
  })
  const locale = await localeOf(placement.userId)
  await push(placement.userId, {
    title: t(locale, 'notify.qualified.title'),
    body: t(locale, 'notify.qualified.body', {
      amount: formatKrDown(amountOre, locale),
      brand: placement.campaign.brand.name,
    }),
    url: `/placements/${placementId}/card`,
  })
}

export async function notifyRejected(placementId: string, reason: string): Promise<void> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { userId: true, fixWindowEndsAt: true },
  })
  const locale = await localeOf(placement.userId)
  const reasonText = t(locale, `placement.rejectReasons.${reason}`)
  await push(placement.userId, {
    title: t(locale, 'notify.rejected.title'),
    body: t(locale, 'notify.rejected.body', { reason: reasonText }),
    url: `/placements/${placementId}`,
  })
  log.info('placement rejected', { placementId, reason })
}

export async function notifyPayoutSent(userId: string, amountOre: number): Promise<void> {
  const locale = await localeOf(userId)
  await push(userId, {
    title: t(locale, 'notify.payoutSent.title'),
    body: t(locale, 'notify.payoutSent.body', { amount: formatKrDown(amountOre, locale) }),
    url: '/wallet',
  })
}

/**
 * A fraud flag is SILENT for the participant (docs/03): telling someone they are under
 * review before a human has looked is both unfair and an invitation to tamper. It goes
 * to the ops queue instead.
 */
export async function notifyFraudFlag(placementId: string, score: number): Promise<void> {
  await notifyOps(`Fraud flag: placement ${placementId} scored ${score}`, { placementId, score })
}

// ---------------------------------------------------------------- brand

async function brandRecipients(campaignId: string): Promise<string[]> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { brand: { select: { users: { where: { deletedAt: null }, select: { email: true } } } } },
  })
  return campaign.brand.users.map((u) => u.email)
}

export async function notifyBrandCampaignLive(campaignId: string): Promise<void> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { name: true },
  })
  for (const email of await brandRecipients(campaignId)) {
    await sendCampaignLiveToBrand({ email, campaignName: campaign.name, campaignId })
  }
}

export async function notifyBrandReviewNeeded(campaignId: string, count: number, reminder = false): Promise<void> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { name: true },
  })
  for (const email of await brandRecipients(campaignId)) {
    await sendBrandReviewNeeded({ email, campaignName: campaign.name, campaignId, count, reminder })
  }
}

export async function notifyFillThreshold(campaignId: string, percent: number): Promise<void> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { name: true },
  })
  for (const email of await brandRecipients(campaignId)) {
    await sendFillThreshold({ email, campaignName: campaign.name, campaignId, percent })
  }
  await notifyOps(`${campaign.name} reached ${percent}% fill`, { campaignId, percent })
}

// ---------------------------------------------------------------- ops

export const sentOpsAlerts: Array<{ text: string; context: Record<string, unknown> }> = []

export function clearOpsAlerts(): void {
  sentOpsAlerts.length = 0
}

/** Slack webhook for ops alerts — docs/06 section 8. */
export async function notifyOps(text: string, context: Record<string, unknown> = {}): Promise<void> {
  sentOpsAlerts.push({ text, context })

  const url = process.env.SLACK_OPS_WEBHOOK_URL
  if (!url) {
    log.info('ops alert', { text, ...context })
    return
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${BRAND} · ${text}` }),
    })
  } catch (error) {
    log.error('slack alert failed', error)
  }
}
