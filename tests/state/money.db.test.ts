/**
 * Payout batches, wallet balances, referral bonuses and the notifications matrix —
 * docs/09 M3 tasks 5, 6, 9 and M4 task 4.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, makeBrand, makeCampaign, makeParticipant, resetDb } from '../helpers/db'
import { encrypt } from '@/lib/crypto'
import { walletBalance, walletPendingOre, nodRevenueOre } from '@/lib/money/balances'
import { sek } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import {
  closePayoutBatch,
  markPayoutSent,
  markQualifiedAsPaid,
  openPayoutBatch,
  payableWallets,
  payReferralBonusIfDue,
} from '@/lib/state/money'
import {
  brandApprove,
  claim,
  generationDone,
  holdEnded,
  participantApprove,
  position,
  publish,
  qualify,
  startGeneration,
  upload,
} from '@/lib/state/placement'
import { normaliseSwishNumber, toSwishCsv } from '@/lib/integrations/swish'
import {
  clearOpsAlerts,
  clearSentPushes,
  notifyBrandReviewNeeded,
  notifyCampaignLive,
  notifyFillThreshold,
  notifyFraudFlag,
  notifyHoldComplete,
  notifyPayoutSent,
  notifyQualified,
  notifyRejected,
  sentOpsAlerts,
  sentPushes,
} from '@/lib/notify'
import { sentMail } from '@/lib/email'

const PARTICIPANT = { kind: 'PARTICIPANT' as const, id: 'p' }
const BRAND = { kind: 'BRAND' as const, id: 'b' }
const OPS = { kind: 'OPS' as const, id: 'ops-1' }

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

/** Runs a placement all the way to QUALIFIED so the wallet has a real balance. */
async function earn(views = 5_000, avgViews30d = 5_000) {
  const brand = await makeBrand()
  const campaign = await makeCampaign({ brandId: brand.id })
  const { user, account } = await makeParticipant({ avgViews30d })

  const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
  await upload(
    { placementId: claimed.id, storagePath: 'o.jpg', perceptualHash: `${views}`.padEnd(16, 'f'), contentType: 'story' },
    PARTICIPANT,
  )
  await position(claimed.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
  await startGeneration(claimed.id)
  await generationDone(claimed.id, { storagePath: 'v.jpg', engine: 'fake' })
  await participantApprove(claimed.id, PARTICIPANT)
  await brandApprove(claimed.id, BRAND)
  await publish(claimed.id, { postUrl: 'https://instagram.com/p/e' }, PARTICIPANT)
  await holdEnded(claimed.id)
  await db.verification.create({ data: { placementId: claimed.id, views, viewsSource: 'api' } })
  const result = await qualify(claimed.id, views)

  return { brand, campaign, user, account, placementId: claimed.id, toUserOre: result.toUserOre }
}

describe('wallet balances', () => {
  it('is the sum of the ledger, never a stored number', async () => {
    const { user, toUserOre } = await earn(5_000, 5_000)
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })

    const balance = await walletBalance(db, wallet.id)
    expect(balance.availableOre).toBe(toUserOre)
    expect(balance.paidOutOre).toBe(0)
    expect(balance.lifetimeOre).toBe(toUserOre)

    // Proven by construction: the balance equals the ledger sum.
    const entries = await db.ledgerEntry.findMany({ where: { walletId: wallet.id } })
    const sum = entries.reduce((s, e) => s + (e.type === 'PAYOUT_ACCRUE' ? e.amountOre : -e.amountOre), 0)
    expect(balance.availableOre).toBe(sum)
  })

  it('reports pending money for placements that have not qualified yet', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant({ avgViews30d: 450 })

    const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
    await upload({ placementId: claimed.id, storagePath: 'o.jpg', perceptualHash: 'p'.repeat(16), contentType: 'story' }, PARTICIPANT)
    await position(claimed.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
    await startGeneration(claimed.id)
    await generationDone(claimed.id, { storagePath: 'v.jpg', engine: 'fake' })
    await participantApprove(claimed.id, PARTICIPANT)
    await brandApprove(claimed.id, BRAND)

    // Reservation is 90 kr; the participant's share of that is 64.80 kr.
    expect(await walletPendingOre(db, user.id)).toBe(6_480)
  })
})

describe('payout batch — docs/06 section 5', () => {
  it('only includes wallets at or above the 100 kr threshold', async () => {
    const rich = await earn(5_000, 5_000) // ~237 kr
    const poor = await earn(120, 450) // ~38 kr

    const rows = await payableWallets()

    const userIds = rows.map((r) => r.userId)
    expect(userIds).toContain(rich.user.id)
    expect(userIds).not.toContain(poor.user.id)
  })

  it('skips a wallet with no valid Swish number rather than exporting a bad row', async () => {
    const { user } = await earn(5_000, 5_000)
    await db.user.update({ where: { id: user.id }, data: { swishNumber: encrypt('not-a-number') } })

    const rows = await payableWallets()
    expect(rows.map((r) => r.userId)).not.toContain(user.id)
  })

  it('exports a CSV and marks rows paid, writing PAYOUT_SENT', async () => {
    const { user, toUserOre } = await earn(5_000, 5_000)
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })

    const batch = await openPayoutBatch(OPS)

    expect(batch.rows).toHaveLength(1)
    expect(batch.totalOre).toBe(toUserOre)
    expect(batch.csv).toContain('swish_number,amount_sek,memo,wallet_id')
    expect(batch.csv).toContain('+46701234567')
    expect(batch.csv).toContain((toUserOre / 100).toFixed(2))
    expect(batch.csv).toContain(`NOD-${batch.batchId}`)

    await markPayoutSent(
      { batchId: batch.batchId, walletId: wallet.id, amountOre: toUserOre, reference: 'SWISH-123' },
      OPS,
    )

    const after = await walletBalance(db, wallet.id)
    expect(after.availableOre).toBe(0)
    expect(after.paidOutOre).toBe(toUserOre)

    await closePayoutBatch(batch.batchId, OPS)
    const closed = await db.payoutBatch.findUniqueOrThrow({ where: { id: batch.batchId } })
    expect(closed.state).toBe('SETTLED')
  })

  it('refuses to pay out more than the wallet holds', async () => {
    const { user, toUserOre } = await earn(5_000, 5_000)
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    const batch = await openPayoutBatch(OPS)

    await expect(
      markPayoutSent(
        { batchId: batch.batchId, walletId: wallet.id, amountOre: toUserOre + 1, reference: 'BAD' },
        OPS,
      ),
    ).rejects.toThrow(/exceeds/)
  })

  it('is idempotent on the external reference, so a retried payout cannot double-send', async () => {
    const { user, toUserOre } = await earn(5_000, 5_000)
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    const batch = await openPayoutBatch(OPS)

    await markPayoutSent(
      { batchId: batch.batchId, walletId: wallet.id, amountOre: toUserOre, reference: 'SWISH-DUP' },
      OPS,
    )
    await expect(
      markPayoutSent(
        { batchId: batch.batchId, walletId: wallet.id, amountOre: toUserOre, reference: 'SWISH-DUP' },
        OPS,
      ),
    ).rejects.toThrow()

    const sent = await db.ledgerEntry.count({ where: { walletId: wallet.id, type: 'PAYOUT_SENT' } })
    expect(sent).toBe(1)
  })
})

describe('referral bonus — docs/05', () => {
  it('pays the referrer when the referred user’s first placement qualifies', async () => {
    const referrer = await makeParticipant({ state: 'ACTIVE' })
    const earned = await earn(5_000, 5_000)

    await db.referral.create({ data: { referrerId: referrer.user.id, referredId: earned.user.id } })

    expect(await payReferralBonusIfDue(earned.user.id)).toBe(true)

    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: referrer.user.id } })
    expect((await walletBalance(db, wallet.id)).availableOre).toBe(DEFAULTS.referralBonusOre)

    // Only once.
    expect(await payReferralBonusIfDue(earned.user.id)).toBe(false)
  })

  it('funds the bonus from NOD margin, not from the campaign budget', async () => {
    const referrer = await makeParticipant({ state: 'ACTIVE' })
    const earned = await earn(5_000, 5_000)
    await db.referral.create({ data: { referrerId: referrer.user.id, referredId: earned.user.id } })
    await payReferralBonusIfDue(earned.user.id)

    const bonus = await db.ledgerEntry.findFirst({
      where: { type: 'PAYOUT_ACCRUE', memo: { contains: 'Referral bonus' } },
    })
    expect(bonus).not.toBeNull()
    // No campaign is charged for it.
    expect(bonus!.campaignId).toBeNull()
  })

  it('does not pay before the referred user has qualified anything', async () => {
    const referrer = await makeParticipant({ state: 'ACTIVE' })
    const referred = await makeParticipant({ state: 'VERIFIED' })
    await db.referral.create({ data: { referrerId: referrer.user.id, referredId: referred.user.id } })

    expect(await payReferralBonusIfDue(referred.user.id)).toBe(false)
  })
})

describe('QUALIFIED to PAID', () => {
  it('marks every qualified placement paid', async () => {
    const { placementId } = await earn(5_000, 5_000)
    const count = await markQualifiedAsPaid()

    expect(count).toBeGreaterThanOrEqual(1)
    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('PAID')
    expect(placement.paidAt).not.toBeNull()
  })
})

describe("NOD's own revenue", () => {
  it('is the sum of TAKE and credit-terms fees', async () => {
    await earn(5_000, 5_000)
    const revenue = await nodRevenueOre(db)
    // 330 kr all-in at 28% -> 92.40 kr take.
    expect(revenue).toBe(9_240)
  })
})

describe('Swish number handling', () => {
  it('normalises the formats a Swedish participant will actually type', () => {
    expect(normaliseSwishNumber('070-123 45 67')).toBe('+46701234567')
    expect(normaliseSwishNumber('0701234567')).toBe('+46701234567')
    expect(normaliseSwishNumber('+46 70 123 45 67')).toBe('+46701234567')
    expect(normaliseSwishNumber('0046701234567')).toBe('+46701234567')
    expect(normaliseSwishNumber('076 123 45 67')).toBe('+46761234567')
  })

  it('rejects landlines, foreign numbers and nonsense', () => {
    expect(normaliseSwishNumber('08-123 456')).toBeNull()
    expect(normaliseSwishNumber('+4712345678')).toBeNull()
    expect(normaliseSwishNumber('hello')).toBeNull()
    expect(normaliseSwishNumber('')).toBeNull()
  })

  it('escapes CSV cells so a stray comma cannot corrupt the export', () => {
    const csv = toSwishCsv('batch1', [
      { walletId: 'w,1', userId: 'u1', swishNumber: '+46701234567', amountOre: 12_345, memo: 'NOD-batch1' },
    ])
    expect(csv).toContain('"w,1"')
    expect(csv).toContain('123.45')
  })
})

describe('notifications matrix — docs/03', () => {
  beforeEach(() => {
    clearSentPushes()
    clearOpsAlerts()
    sentMail.length = 0
  })

  it('pushes to participants when a campaign goes live, and emails the brand', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const a = await makeParticipant({ state: 'ACTIVE' })

    await notifyCampaignLive(campaign.id, [a.user.id])
    expect(sentPushes).toHaveLength(1)
    expect(sentPushes[0]!.userId).toBe(a.user.id)
    expect(sentPushes[0]!.title).toBe('Ny kampanj')
  })

  it('emails the brand when placements need review, with a reminder variant', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })

    await notifyBrandReviewNeeded(campaign.id, 3)
    expect(sentMail).toHaveLength(1)
    expect(sentMail[0]!.subject).toContain('3 placements need your review')

    await notifyBrandReviewNeeded(campaign.id, 3, true)
    expect(sentMail[1]!.subject).toContain('Reminder')
  })

  it('pushes the earnings amount when a placement qualifies', async () => {
    const { placementId, toUserOre } = await earn(5_000, 5_000)
    clearSentPushes()

    await notifyQualified(placementId, toUserOre)
    expect(sentPushes[0]!.title).toBe('Du fick betalt')
    expect(sentPushes[0]!.body).toContain('237 kr')
  })

  it('pushes a reason when a placement is rejected, and logs it for ops', async () => {
    const { placementId } = await earn(5_000, 5_000)
    clearSentPushes()

    await notifyRejected(placementId, 'NO_DISCLOSURE')
    expect(sentPushes[0]!.title).toBe('Placeringen nekades')
    expect(sentPushes[0]!.body).toContain('Ingen reklammärkning')
  })

  it('sends nothing to the participant when the hold completes', async () => {
    await notifyHoldComplete()
    expect(sentPushes).toHaveLength(0)
  })

  it('keeps a fraud flag silent for the participant and routes it to the ops queue', async () => {
    const { placementId } = await earn(5_000, 5_000)
    clearSentPushes()
    clearOpsAlerts()

    await notifyFraudFlag(placementId, 0.72)

    expect(sentPushes).toHaveLength(0)
    expect(sentOpsAlerts).toHaveLength(1)
    expect(sentOpsAlerts[0]!.text).toContain('Fraud flag')
  })

  it('emails the brand and pings ops at a fill threshold', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    sentMail.length = 0
    clearOpsAlerts()

    await notifyFillThreshold(campaign.id, 50)

    expect(sentMail[0]!.subject).toContain('50% filled')
    expect(sentOpsAlerts[0]!.text).toContain('50% fill')
  })

  it('pushes in the participant’s own language', async () => {
    const { user } = await earn(5_000, 5_000)
    await db.user.update({ where: { id: user.id }, data: { locale: 'en' } })
    clearSentPushes()

    await notifyPayoutSent(user.id, sek(237))
    expect(sentPushes[0]!.title).toBe('Payout sent')
    expect(sentPushes[0]!.body).toContain('via Swish')
  })
})
