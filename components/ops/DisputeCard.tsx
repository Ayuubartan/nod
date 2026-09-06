'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsResolveDispute } from '@/app/(ops)/actions'

/**
 * A brand dispute — docs/03 edge case 8: "ops reviews checks 2/3 only; payouts stand
 * unless proven; NOD absorbs the cost in the pilot."
 *
 * So this card shows exactly two pieces of evidence — the disclosure result and the
 * media-match score — and neither outcome reverses the participant's payout.
 */
export function DisputeCard({
  placementId,
  handle,
  campaignLabel,
  reason,
  disclosureOk,
  mediaMatch,
  qualifiedViews,
}: {
  placementId: string
  handle: string
  campaignLabel: string
  reason: string
  disclosureOk: boolean | null
  mediaMatch: number | null
  qualifiedViews: number | null
}) {
  const router = useRouter()
  const [resolution, setResolution] = useState('')
  const [pending, setPending] = useState(false)

  const run = async (upheld: boolean) => {
    setPending(true)
    await opsResolveDispute(placementId, upheld, resolution)
    setPending(false)
    router.refresh()
  }

  return (
    <div className="card p-4">
      <p className="font-semibold text-sm">@{handle}</p>
      <p className="text-xs text-[var(--color-ink-3)] mb-3">{campaignLabel}</p>

      <p className="text-sm card px-3 py-2 bg-[var(--color-bg)] mb-3">{reason}</p>

      <dl className="grid grid-cols-3 gap-2 text-xs mb-3">
        <div>
          <dt className="text-[var(--color-ink-3)]">Check 2 disclosure</dt>
          <dd className="font-semibold" style={{ color: disclosureOk ? 'var(--color-green)' : 'var(--color-red)' }}>
            {disclosureOk === null ? '—' : disclosureOk ? 'Pass' : 'Fail'}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--color-ink-3)]">Check 3 media</dt>
          <dd className="tabular font-semibold">{mediaMatch === null ? '—' : mediaMatch.toFixed(2)}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-ink-3)]">Qualified</dt>
          <dd className="tabular">{qualifiedViews?.toLocaleString('sv-SE') ?? '—'}</dd>
        </div>
      </dl>

      <p className="text-xs text-[var(--color-ink-3)] mb-2">
        The payout stands either way. Upholding records the finding and NOD absorbs the cost.
      </p>

      <textarea
        className="field text-sm mb-2"
        rows={2}
        placeholder="Resolution (required)"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
      />

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn btn-secondary text-sm"
          disabled={pending || resolution.trim().length === 0}
          onClick={() => run(false)}
        >
          Reject dispute
        </button>
        <button
          type="button"
          className="btn btn-secondary text-sm text-[var(--color-red)]"
          disabled={pending || resolution.trim().length === 0}
          onClick={() => run(true)}
        >
          Uphold
        </button>
      </div>
    </div>
  )
}
