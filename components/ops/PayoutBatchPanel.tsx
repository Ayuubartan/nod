'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsCloseBatch, opsMarkPayoutSent, opsOpenPayoutBatch } from '@/app/(ops)/actions'
import { formatOre } from '@/lib/money/calc'

type Row = { walletId: string; handle: string; amountOre: number }

/**
 * The pilot payout flow: open a batch (which freezes the CSV), pay each row by hand in
 * Swish Företag, then paste the Swish reference back so PAYOUT_SENT is written with a
 * traceable external reference.
 */
export function PayoutBatchPanel({ rows }: { rows: Row[] }) {
  const router = useRouter()

  const [batch, setBatch] = useState<{ batchId: string; csv: string; totalOre: number } | null>(null)
  const [references, setReferences] = useState<Record<string, string>>({})
  const [paid, setPaid] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onOpenBatch() {
    setPending(true)
    setError(null)
    const result = await opsOpenPayoutBatch()
    setPending(false)
    if (result.ok && result.data) setBatch(result.data)
    else if (!result.ok) setError(result.error)
  }

  function downloadCsv() {
    if (!batch) return
    const blob = new Blob([batch.csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `nod-payouts-${batch.batchId}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (rows.length === 0) {
    return <p className="card p-6 text-center text-sm text-[var(--color-ink-3)]">Nothing to pay.</p>
  }

  return (
    <div className="grid gap-4">
      {!batch ? (
        <button type="button" className="btn btn-primary" disabled={pending} onClick={onOpenBatch}>
          Open batch ({rows.length} wallets)
        </button>
      ) : (
        <div className="card p-4 grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold tabular">{batch.batchId}</p>
              <p className="text-xs text-[var(--color-ink-3)]">{formatOre(batch.totalOre)}</p>
            </div>
            <button type="button" className="btn btn-secondary text-sm" onClick={downloadCsv}>
              Download CSV
            </button>
          </div>

          <ul className="grid gap-2">
            {rows.map((row) => (
              <li key={row.walletId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-32 truncate">@{row.handle}</span>
                <span className="amount w-24 text-right">{formatOre(row.amountOre)}</span>
                <input
                  className="field text-sm flex-1 min-w-40"
                  placeholder="Swish reference"
                  value={references[row.walletId] ?? ''}
                  disabled={paid.has(row.walletId)}
                  onChange={(e) => setReferences((r) => ({ ...r, [row.walletId]: e.target.value }))}
                />
                <button
                  type="button"
                  className="btn btn-secondary text-xs"
                  disabled={pending || paid.has(row.walletId) || !(references[row.walletId] ?? '').trim()}
                  onClick={async () => {
                    setPending(true)
                    const result = await opsMarkPayoutSent({
                      batchId: batch.batchId,
                      walletId: row.walletId,
                      amountOre: row.amountOre,
                      reference: references[row.walletId]!.trim(),
                    })
                    setPending(false)
                    if (result.ok) setPaid((s) => new Set(s).add(row.walletId))
                    else setError(result.error)
                  }}
                >
                  {paid.has(row.walletId) ? 'Paid' : 'Mark paid'}
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="btn btn-primary text-sm"
            disabled={pending || paid.size < rows.length}
            onClick={async () => {
              setPending(true)
              await opsCloseBatch(batch.batchId)
              setPending(false)
              setBatch(null)
              router.refresh()
            }}
          >
            Close batch
          </button>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
