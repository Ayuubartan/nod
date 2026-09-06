/**
 * Append-only ledger — docs/03 section 4, docs/04 "Derived numbers".
 *
 * Rules this module enforces:
 *   - entries are only ever INSERTed; nothing here updates or deletes a LedgerEntry
 *   - every amount is a non-negative integer in öre (direction is carried by `type`)
 *   - a balance is never stored; it is always a sum over entries (see balances.ts)
 *
 * Every function takes a Prisma transaction client, because a ledger write is always
 * part of the same transaction as the state transition that caused it.
 */

import type { LedgerType, Prisma, PrismaClient } from '@prisma/client'

export type Tx = Prisma.TransactionClient | PrismaClient

export type LedgerWrite = {
  type: LedgerType
  amountOre: number
  campaignId?: string | null
  walletId?: string | null
  placementId?: string | null
  batchId?: string | null
  memo?: string | null
  /** Stripe payment intent, Swish reference, etc. Unique — makes replays idempotent. */
  externalRef?: string | null
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerError'
  }
}

function validate(entry: LedgerWrite): void {
  if (!Number.isInteger(entry.amountOre)) {
    throw new LedgerError(`amountOre must be an integer in öre, got ${entry.amountOre}`)
  }
  if (entry.amountOre < 0) {
    throw new LedgerError(
      `amountOre must be non-negative — direction is carried by the entry type, got ${entry.amountOre} for ${entry.type}`,
    )
  }
}

/** Write one entry. Zero-amount entries are skipped so the ledger stays readable. */
export async function post(tx: Tx, entry: LedgerWrite): Promise<void> {
  validate(entry)
  if (entry.amountOre === 0) return
  await tx.ledgerEntry.create({
    data: {
      type: entry.type,
      amountOre: entry.amountOre,
      campaignId: entry.campaignId ?? null,
      walletId: entry.walletId ?? null,
      placementId: entry.placementId ?? null,
      batchId: entry.batchId ?? null,
      memo: entry.memo ?? null,
      externalRef: entry.externalRef ?? null,
    },
  })
}

/** Write several entries as one unit. Caller supplies the transaction. */
export async function postMany(tx: Tx, entries: LedgerWrite[]): Promise<void> {
  for (const entry of entries) validate(entry)
  const rows = entries.filter((e) => e.amountOre > 0)
  if (rows.length === 0) return
  await tx.ledgerEntry.createMany({
    data: rows.map((e) => ({
      type: e.type,
      amountOre: e.amountOre,
      campaignId: e.campaignId ?? null,
      walletId: e.walletId ?? null,
      placementId: e.placementId ?? null,
      batchId: e.batchId ?? null,
      memo: e.memo ?? null,
      externalRef: e.externalRef ?? null,
    })),
  })
}

/**
 * True if an entry with this externalRef already exists. Webhooks call this before
 * posting so a redelivered Stripe event can never double-fund a campaign.
 */
export async function alreadyPosted(tx: Tx, externalRef: string): Promise<boolean> {
  const found = await tx.ledgerEntry.findUnique({ where: { externalRef }, select: { id: true } })
  return found !== null
}

// ---------------------------------------------------------------- typed writers
// Named per the entry-type table in docs/03 section 4, so the call sites read like
// the spec rather than like generic ledger plumbing.

export const deposit = (tx: Tx, campaignId: string, amountOre: number, externalRef?: string) =>
  post(tx, { type: 'DEPOSIT', amountOre, campaignId, externalRef, memo: 'Brand deposit' })

export const reserve = (tx: Tx, campaignId: string, placementId: string, amountOre: number) =>
  post(tx, { type: 'RESERVE', amountOre, campaignId, placementId, memo: 'Claim reservation' })

export const releaseReservation = (
  tx: Tx,
  campaignId: string,
  placementId: string,
  amountOre: number,
  memo = 'Reservation released',
) => post(tx, { type: 'RELEASE_RESERVATION', amountOre, campaignId, placementId, memo })

export const creditTermsFee = (tx: Tx, campaignId: string, amountOre: number) =>
  post(tx, { type: 'CREDIT_TERMS_FEE', amountOre, campaignId, memo: 'Credit terms fee' })

export const payoutSent = (
  tx: Tx,
  walletId: string,
  amountOre: number,
  batchId: string,
  externalRef?: string,
) => post(tx, { type: 'PAYOUT_SENT', amountOre, walletId, batchId, externalRef, memo: 'Swish payout' })

export const refund = (tx: Tx, campaignId: string, amountOre: number, externalRef?: string) =>
  post(tx, { type: 'REFUND', amountOre, campaignId, externalRef, memo: 'Unspent budget refunded' })

export const rollover = (tx: Tx, campaignId: string, amountOre: number, memo: string) =>
  post(tx, { type: 'ROLLOVER', amountOre, campaignId, memo })

/**
 * The four entries a qualified placement produces, written together.
 * Amounts come from `settle()` in calc.ts — this function does no arithmetic of its own.
 */
export async function settlePlacement(
  tx: Tx,
  args: {
    campaignId: string
    placementId: string
    walletId: string
    allInOre: number
    toUserOre: number
    toNodOre: number
    releaseOre: number
  },
): Promise<void> {
  if (args.toUserOre + args.toNodOre !== args.allInOre) {
    throw new LedgerError(
      `settlement does not reconcile: ${args.toUserOre} + ${args.toNodOre} !== ${args.allInOre}`,
    )
  }
  await postMany(tx, [
    {
      type: 'SETTLE',
      amountOre: args.allInOre,
      campaignId: args.campaignId,
      placementId: args.placementId,
      memo: 'Placement qualified',
    },
    {
      type: 'PAYOUT_ACCRUE',
      amountOre: args.toUserOre,
      campaignId: args.campaignId,
      placementId: args.placementId,
      walletId: args.walletId,
      memo: 'Participant share',
    },
    {
      type: 'TAKE',
      amountOre: args.toNodOre,
      campaignId: args.campaignId,
      placementId: args.placementId,
      memo: 'NOD take',
    },
    {
      type: 'RELEASE_RESERVATION',
      amountOre: args.releaseOre,
      campaignId: args.campaignId,
      placementId: args.placementId,
      memo: 'Unused reservation returned to budget',
    },
  ])
}

/** Referral bonus. Funded from NOD margin, never from a campaign budget (docs/05). */
export const referralBonus = (tx: Tx, walletId: string, amountOre: number, memo: string) =>
  post(tx, { type: 'PAYOUT_ACCRUE', amountOre, walletId, campaignId: null, memo })
