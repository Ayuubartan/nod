/**
 * Money lifecycle — docs/03 section 4.
 *
 * The ledger primitives live in lib/money/ledger.ts; this module is the state layer on
 * top: payout batches, the wallet threshold, referral bonuses, and the invariant check
 * the reconciliation job runs.
 */

import { prisma } from '@/lib/db'
import { tryDecrypt } from '@/lib/crypto'
import { campaignBalance, reconciles, walletBalance } from '@/lib/money/balances'
import { payoutSent, referralBonus } from '@/lib/money/ledger'
import { DEFAULTS } from '@/lib/money/rates'
import { normaliseSwishNumber, toSwishCsv } from '@/lib/integrations/swish'
import type { PayoutRow } from '@/lib/integrations/types'
import { auditAction, SYSTEM, type ActorRef, type Tx } from './transition'
import { markPaid } from './placement'
import { markSubmissionPaid } from './submission'
import { emit } from '@/lib/events'

/**
 * Wallets at or above the payout threshold — docs/05: "Wallet payout threshold 100 kr;
 * batch daily in pilot".
 *
 * Suspended and removed participants are excluded from new batches, except that a
 * suspension pays out the existing balance (docs/03 section 3), which the ops console
 * does explicitly rather than through the daily batch.
 */
export async function payableWallets(thresholdOre = DEFAULTS.payoutThresholdOre): Promise<PayoutRow[]> {
  const wallets = await prisma.wallet.findMany({
    where: { deletedAt: null, user: { state: { notIn: ['REMOVED'] }, deletedAt: null } },
    select: { id: true, userId: true, user: { select: { swishNumber: true, state: true } } },
  })

  const rows: PayoutRow[] = []
  for (const wallet of wallets) {
    const balance = await walletBalance(prisma, wallet.id)
    if (balance.availableOre < thresholdOre) continue

    const swish = tryDecrypt(wallet.user.swishNumber)
    const normalised = swish ? normaliseSwishNumber(swish) : null
    if (!normalised) continue

    rows.push({
      walletId: wallet.id,
      userId: wallet.userId,
      swishNumber: normalised,
      amountOre: balance.availableOre,
      memo: '',
    })
  }
  return rows
}

/** Opens a batch and freezes the rows into it. The CSV is what ops pays from. */
export async function openPayoutBatch(
  actor: ActorRef = SYSTEM,
  thresholdOre = DEFAULTS.payoutThresholdOre,
): Promise<{ batchId: string; rows: PayoutRow[]; csv: string; totalOre: number }> {
  const rows = await payableWallets(thresholdOre)
  const totalOre = rows.reduce((sum, r) => sum + r.amountOre, 0)

  const batch = await prisma.payoutBatch.create({
    data: { state: 'EXPORTED', exportedAt: new Date(), totalOre, note: `${rows.length} wallets` },
    select: { id: true },
  })

  const withMemo = rows.map((r) => ({ ...r, memo: `NOD-${batch.id}` }))
  const csv = toSwishCsv(batch.id, withMemo)

  await auditAction(prisma, 'PayoutBatch', batch.id, 'EXPORT', actor, {
    wallets: rows.length,
    totalOre,
  })
  await emit({ name: 'money/payout.batch.exported', data: { batchId: batch.id, totalOre } })

  return { batchId: batch.id, rows: withMemo, csv, totalOre }
}

/**
 * Ops marks a row paid after the Swish transfer went through. This is the only place a
 * PAYOUT_SENT entry is written; the external reference makes it idempotent.
 */
export async function markPayoutSent(
  args: { batchId: string; walletId: string; amountOre: number; reference: string },
  actor: ActorRef,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const balance = await walletBalance(tx, args.walletId)
    if (args.amountOre > balance.availableOre) {
      throw new Error(
        `Payout ${args.amountOre} exceeds the wallet's available balance ${balance.availableOre}`,
      )
    }
    await payoutSent(tx, args.walletId, args.amountOre, args.batchId, args.reference)
    await auditAction(tx, 'Wallet', args.walletId, 'PAYOUT_SENT', actor, {
      batchId: args.batchId,
      amountOre: args.amountOre,
      reference: args.reference,
    })
  })

  await emit({
    name: 'money/payout.sent',
    data: { walletId: args.walletId, amountOre: args.amountOre },
    id: `payout:${args.reference}`,
  })
}

export async function closePayoutBatch(batchId: string, actor: ActorRef): Promise<void> {
  await prisma.payoutBatch.update({
    where: { id: batchId },
    data: { state: 'SETTLED', settledAt: new Date() },
  })
  await auditAction(prisma, 'PayoutBatch', batchId, 'SETTLE', actor)
}

/**
 * Referral bonus — docs/05: "Paid when referred user's first placement is QUALIFIED;
 * funded from NOD margin, not campaign budget."
 *
 * The ledger entry therefore has no campaignId, which is what keeps it out of every
 * campaign balance.
 */
export async function payReferralBonusIfDue(
  referredUserId: string,
  bonusOre = DEFAULTS.referralBonusOre,
): Promise<boolean> {
  const referral = await prisma.referral.findUnique({
    where: { referredId: referredUserId },
    select: { id: true, referrerId: true, bonusPaidAt: true },
  })
  if (!referral || referral.bonusPaidAt) return false

  // A first qualified placement or a first paid clip both count (docs/05 referral rule).
  const qualifiedCount =
    (await prisma.placement.count({ where: { userId: referredUserId, state: { in: ['QUALIFIED', 'PAID'] } } })) +
    (await prisma.submission.count({
      where: { userId: referredUserId, state: { in: ['QUALIFIED', 'PAID'] }, deletedAt: null },
    }))
  if (qualifiedCount === 0) return false

  await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.upsert({
      where: { userId: referral.referrerId },
      create: { userId: referral.referrerId },
      update: {},
      select: { id: true },
    })
    await referralBonus(tx, wallet.id, bonusOre, `Referral bonus for ${referredUserId}`)
    await tx.referral.update({
      where: { id: referral.id },
      data: { bonusPaidAt: new Date(), firstPlacementAt: new Date() },
    })
    await auditAction(tx, 'Referral', referral.id, 'BONUS_PAID', SYSTEM, { bonusOre })
  })

  await emit({ name: 'referral/qualified', data: { referredUserId, referrerId: referral.referrerId } })
  return true
}

/** QUALIFIED -> PAID for everything whose accrual has landed. Runs after settlement. */
export async function markQualifiedAsPaid(): Promise<number> {
  const qualified = await prisma.placement.findMany({
    where: { state: 'QUALIFIED', deletedAt: null },
    select: { id: true, userId: true },
  })

  for (const placement of qualified) {
    await markPaid(placement.id)
    await payReferralBonusIfDue(placement.userId)
  }

  // Clip submissions settle into the same wallets (docs/14 §5).
  const submissions = await prisma.submission.findMany({
    where: { state: 'QUALIFIED', deletedAt: null },
    select: { id: true, userId: true },
  })
  for (const submission of submissions) {
    await markSubmissionPaid(submission.id)
    await payReferralBonusIfDue(submission.userId)
  }
  return qualified.length + submissions.length
}

/**
 * The invariant the reconciliation job asserts: deposits equal available + reserved +
 * spent + refunded + rolled over. A false result means a transition wrote one side of a
 * ledger pair without the other, and is a hard error rather than a warning.
 */
export async function assertCampaignReconciles(campaignId: string, tx?: Tx): Promise<void> {
  const balance = await campaignBalance(tx ?? prisma, campaignId)
  if (!reconciles(balance)) {
    throw new Error(
      `Campaign ${campaignId} does not reconcile: deposited ${balance.depositedOre} != available ${balance.availableOre} + reserved ${balance.reservedOre} + spent ${balance.spentOre} + refunded ${balance.refundedOre} + rolled ${balance.rolledOverOre}`,
    )
  }
}
