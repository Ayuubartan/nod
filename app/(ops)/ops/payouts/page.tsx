import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { payableWallets } from '@/lib/state/money'
import { formatOre } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import { PayoutBatchPanel } from '@/components/ops/PayoutBatchPanel'

/**
 * Payout batch — docs/02 section C, docs/06 section 5.
 * Export the CSV, pay from Swish Företag by hand, mark each row paid.
 */
export const dynamic = 'force-dynamic'

export default async function OpsPayoutsPage() {
  await requireOps()

  const [payable, batches] = await Promise.all([
    payableWallets(),
    prisma.payoutBatch.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { _count: { select: { entries: true } } },
    }),
  ])

  // Handles are shown so ops can sanity-check a row against the participant; the Swish
  // number itself is only in the exported CSV, never rendered on screen.
  const users = await prisma.user.findMany({
    where: { id: { in: payable.map((row) => row.userId) } },
    select: { id: true, accounts: { select: { handle: true }, take: 1 } },
  })
  const handles = new Map(users.map((u) => [u.id, u.accounts[0]?.handle ?? '—']))

  const totalOre = payable.reduce((sum, row) => sum + row.amountOre, 0)

  return (
    <div className="grid gap-8">
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h1 className="text-xl">Ready to pay</h1>
          <p className="text-sm text-[var(--color-ink-2)] tabular">
            {payable.length} wallets · {formatOre(totalOre)} · threshold{' '}
            {formatOre(DEFAULTS.payoutThresholdOre)}
          </p>
        </div>

        <PayoutBatchPanel
          rows={payable.map((row) => ({
            walletId: row.walletId,
            handle: handles.get(row.userId) ?? '—',
            amountOre: row.amountOre,
          }))}
        />
      </section>

      <section>
        <h2 className="text-xl mb-4">Recent batches</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)]">
                <th className="text-left font-semibold px-4 py-3">Batch</th>
                <th className="text-left font-semibold px-4 py-3">State</th>
                <th className="text-right font-semibold px-4 py-3">Total</th>
                <th className="text-right font-semibold px-4 py-3">Rows</th>
                <th className="text-left font-semibold px-4 py-3">Exported</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="px-4 py-3 tabular text-xs">{batch.id}</td>
                  <td className="px-4 py-3">
                    <span className="chip text-xs">{batch.state}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular">{formatOre(batch.totalOre)}</td>
                  <td className="px-4 py-3 text-right tabular">{batch._count.entries}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-2)]">
                    {batch.exportedAt?.toLocaleString('sv-SE') ?? '—'}
                  </td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                    No batches yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
