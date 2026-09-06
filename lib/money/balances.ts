/**
 * Derived balances — docs/04 "Derived numbers (never stored)".
 *
 *   campaign.available = DEPOSIT - RESERVE + RELEASE_RESERVATION - REFUND - ROLLOVER
 *   campaign.reserved  = RESERVE - RELEASE_RESERVATION - SETTLE
 *   campaign.spent     = PAYOUT_ACCRUE + TAKE
 *   wallet.available   = PAYOUT_ACCRUE - PAYOUT_SENT
 *
 * Note on the available/reserved pair: a SETTLE consumes the reserved side, and the
 * unspent part of the reservation comes back to available as its own
 * RELEASE_RESERVATION entry (written by settlePlacement). That keeps both sums simple
 * sums over entry types with no special cases — which is what makes them auditable.
 *
 * Nothing in the app stores a balance. Every screen reads these functions.
 */

import type { LedgerType, Prisma, PrismaClient } from '@prisma/client'

type Tx = Prisma.TransactionClient | PrismaClient

export type CampaignBalance = {
  campaignId: string
  budgetOre: number
  depositedOre: number
  availableOre: number
  reservedOre: number
  spentOre: number
  takeOre: number
  participantAccruedOre: number
  refundedOre: number
  rolledOverOre: number
}

export type WalletBalance = {
  walletId: string
  /** accrued and payable now */
  availableOre: number
  /** already sent by Swish */
  paidOutOre: number
  /** lifetime accrual */
  lifetimeOre: number
}

async function sumsByType(
  tx: Tx,
  where: Prisma.LedgerEntryWhereInput,
): Promise<Record<LedgerType, number>> {
  const rows = await tx.ledgerEntry.groupBy({
    by: ['type'],
    where,
    _sum: { amountOre: true },
  })
  const out = {} as Record<LedgerType, number>
  for (const row of rows) out[row.type] = row._sum.amountOre ?? 0
  return out
}

const at = (sums: Record<LedgerType, number>, type: LedgerType): number => sums[type] ?? 0

export async function campaignBalance(tx: Tx, campaignId: string): Promise<CampaignBalance> {
  const [campaign, sums] = await Promise.all([
    tx.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { budget: true } }),
    sumsByType(tx, { campaignId }),
  ])

  const deposited = at(sums, 'DEPOSIT')
  const reserved = at(sums, 'RESERVE')
  const released = at(sums, 'RELEASE_RESERVATION')
  const settled = at(sums, 'SETTLE')
  const accrued = at(sums, 'PAYOUT_ACCRUE')
  const take = at(sums, 'TAKE')
  const refunded = at(sums, 'REFUND')
  const rolled = at(sums, 'ROLLOVER')
  const adjustment = at(sums, 'ADJUSTMENT')

  return {
    campaignId,
    budgetOre: campaign.budget,
    depositedOre: deposited,
    availableOre: deposited - reserved + released - refunded - rolled + adjustment,
    reservedOre: reserved - released - settled,
    spentOre: accrued + take,
    takeOre: take,
    participantAccruedOre: accrued,
    refundedOre: refunded,
    rolledOverOre: rolled,
  }
}

/** One query for a whole list of campaigns — the brand and ops index screens use this. */
export async function campaignBalances(
  tx: Tx,
  campaignIds: string[],
): Promise<Map<string, CampaignBalance>> {
  const out = new Map<string, CampaignBalance>()
  if (campaignIds.length === 0) return out

  const [campaigns, rows] = await Promise.all([
    tx.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, budget: true } }),
    tx.ledgerEntry.groupBy({
      by: ['campaignId', 'type'],
      where: { campaignId: { in: campaignIds } },
      _sum: { amountOre: true },
    }),
  ])

  const budgets = new Map(campaigns.map((c) => [c.id, c.budget]))
  const grouped = new Map<string, Record<LedgerType, number>>()
  for (const row of rows) {
    if (!row.campaignId) continue
    const bucket = grouped.get(row.campaignId) ?? ({} as Record<LedgerType, number>)
    bucket[row.type] = row._sum.amountOre ?? 0
    grouped.set(row.campaignId, bucket)
  }

  for (const id of campaignIds) {
    const sums = grouped.get(id) ?? ({} as Record<LedgerType, number>)
    const deposited = at(sums, 'DEPOSIT')
    const reserved = at(sums, 'RESERVE')
    const released = at(sums, 'RELEASE_RESERVATION')
    const settled = at(sums, 'SETTLE')
    const accrued = at(sums, 'PAYOUT_ACCRUE')
    const take = at(sums, 'TAKE')
    const refunded = at(sums, 'REFUND')
    const rolled = at(sums, 'ROLLOVER')
    const adjustment = at(sums, 'ADJUSTMENT')

    out.set(id, {
      campaignId: id,
      budgetOre: budgets.get(id) ?? 0,
      depositedOre: deposited,
      availableOre: deposited - reserved + released - refunded - rolled + adjustment,
      reservedOre: reserved - released - settled,
      spentOre: accrued + take,
      takeOre: take,
      participantAccruedOre: accrued,
      refundedOre: refunded,
      rolledOverOre: rolled,
    })
  }
  return out
}

export async function walletBalance(tx: Tx, walletId: string): Promise<WalletBalance> {
  const sums = await sumsByType(tx, { walletId })
  const accrued = at(sums, 'PAYOUT_ACCRUE')
  const sent = at(sums, 'PAYOUT_SENT')
  return {
    walletId,
    availableOre: accrued - sent,
    paidOutOre: sent,
    lifetimeOre: accrued,
  }
}

/**
 * Money a participant will get but cannot be paid yet: placements that are approved or
 * live but have not qualified. Shown as "pending" on the wallet screen (docs/02 A5).
 */
export async function walletPendingOre(tx: Tx, userId: string): Promise<number> {
  const pending = await tx.placement.findMany({
    where: {
      userId,
      deletedAt: null,
      state: { in: ['APPROVED', 'PUBLISHED', 'VERIFYING', 'FLAGGED', 'QUALIFIED'] },
    },
    select: { reservationOre: true, campaign: { select: { payoutTemplate: { select: { takeRateBps: true } } } } },
  })
  return pending.reduce((total, p) => {
    const bps = p.campaign.payoutTemplate?.takeRateBps ?? 2800
    return total + Math.floor((p.reservationOre * (10_000 - bps)) / 10_000)
  }, 0)
}

/** NOD's own revenue across all campaigns — the ops dashboard number. */
export async function nodRevenueOre(tx: Tx): Promise<number> {
  const sums = await sumsByType(tx, {})
  return at(sums, 'TAKE') + at(sums, 'CREDIT_TERMS_FEE')
}

/**
 * Invariant check used by tests and by the reconciliation job: for a campaign,
 * deposits must always equal available + reserved + spent + refunded + rolled over.
 * If this is ever false, a transition wrote a ledger entry without its counterpart.
 */
export function reconciles(b: CampaignBalance): boolean {
  return b.depositedOre === b.availableOre + b.reservedOre + b.spentOre + b.refundedOre + b.rolledOverOre
}
