'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsClearFraudFlag, opsConfirmFraud } from '@/app/(ops)/actions'
import { Countdown } from '@/components/Countdown'

type Factor = { name: string; score: number; weight: number; detail: string }

/**
 * A flagged placement with its full score breakdown — docs/02 section C:
 * "fraud flags with score breakdown -> clear / reject / suspend".
 *
 * Both outcomes require a written reason, because both are decisions someone may have
 * to defend later: clearing pays out money, confirming costs a participant their
 * account.
 */
export function FraudCard({
  placementId,
  handle,
  campaignLabel,
  score,
  factors,
  views,
  avgViews30d,
  followers,
  flaggedSince,
}: {
  placementId: string
  handle: string
  campaignLabel: string
  score: number
  factors: Factor[]
  views: number
  avgViews30d: number
  followers: number
  flaggedSince: string
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slaDeadline = new Date(new Date(flaggedSince).getTime() + 48 * 60 * 60 * 1000).toISOString()

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setPending(true)
    setError(null)
    const result = await fn()
    setPending(false)
    if (result.ok) router.refresh()
    else setError(result.error ?? 'error')
  }

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="font-semibold text-sm">@{handle}</p>
          <p className="text-xs text-[var(--color-ink-3)]">{campaignLabel}</p>
        </div>
        <span className="amount font-bold text-[var(--color-red)]">{score.toFixed(2)}</span>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-xs mb-3">
        <div>
          <dt className="text-[var(--color-ink-3)]">Views</dt>
          <dd className="tabular font-semibold">{views.toLocaleString('sv-SE')}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-ink-3)]">Baseline</dt>
          <dd className="tabular">{avgViews30d.toLocaleString('sv-SE')}</dd>
        </div>
        <div>
          <dt className="text-[var(--color-ink-3)]">Followers</dt>
          <dd className="tabular">{followers.toLocaleString('sv-SE')}</dd>
        </div>
      </dl>

      <ul className="grid gap-1 mb-3">
        {factors.map((factor) => (
          <li key={factor.name} className="flex items-center gap-2 text-xs">
            <span className="w-32 shrink-0 text-[var(--color-ink-2)]">{factor.name}</span>
            <span className="flex-1 h-1.5 rounded-full bg-[var(--color-line)] overflow-hidden">
              <span
                className="block h-full"
                style={{
                  width: `${Math.round(factor.score * 100)}%`,
                  background: factor.score > 0.5 ? 'var(--color-red)' : 'var(--color-amber)',
                }}
              />
            </span>
            <span className="tabular w-10 text-right text-[var(--color-ink-3)]">
              {factor.score.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>

      {factors.length > 0 && (
        <details className="text-xs text-[var(--color-ink-2)] mb-3">
          <summary className="cursor-pointer">Details</summary>
          <ul className="mt-1 grid gap-1">
            {factors.map((factor) => (
              <li key={factor.name}>
                <strong>{factor.name}:</strong> {factor.detail}
              </li>
            ))}
          </ul>
        </details>
      )}

      <input
        className="field text-sm mb-2"
        placeholder="Reason (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn btn-primary text-sm"
          disabled={pending || reason.trim().length === 0}
          onClick={() => run(() => opsClearFraudFlag(placementId, reason))}
        >
          Clear and pay
        </button>
        <button
          type="button"
          className="btn btn-secondary text-sm text-[var(--color-red)]"
          disabled={pending || reason.trim().length === 0}
          onClick={() => run(() => opsConfirmFraud(placementId, reason))}
        >
          Confirm fraud
        </button>
      </div>

      <p className="text-xs text-[var(--color-ink-3)] mt-2">
        SLA <Countdown to={slaDeadline} />
      </p>

      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
