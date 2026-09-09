import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

type Tx = Prisma.TransactionClient | typeof prisma

/**
 * What each submission actually paid its creator — the PAYOUT_ACCRUE rows keyed by
 * submission. Read from the ledger every time (rule 2): nothing stores the amount.
 */
export async function payoutBySubmission(ids: string[], tx: Tx = prisma): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await tx.ledgerEntry.groupBy({
    by: ['submissionId'],
    where: { submissionId: { in: ids }, type: 'PAYOUT_ACCRUE' },
    _sum: { amountOre: true },
  })
  return new Map(rows.map((r) => [r.submissionId as string, r._sum.amountOre ?? 0]))
}
