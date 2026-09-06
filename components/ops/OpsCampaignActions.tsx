'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  opsApproveCampaign,
  opsCloseCampaign,
  opsFundCampaign,
  opsPauseCampaign,
  opsReconcileCampaign,
  opsReturnCampaign,
} from '@/app/(ops)/actions'

/**
 * Ops campaign controls. Every action that forces a state change takes a mandatory
 * reason, which is written to the audit log (docs/02 section C).
 */
export function OpsCampaignActions({
  campaignId,
  state,
  compact = false,
}: {
  campaignId: string
  state: string
  compact?: boolean
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(!compact)

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setPending(true)
    setError(null)
    const result = await fn()
    setPending(false)
    if (result.ok) {
      setReason('')
      router.refresh()
    } else {
      setError(result.error ?? 'error')
    }
  }

  if (compact && !open) {
    return (
      <button type="button" className="text-xs underline text-[var(--color-ink-2)]" onClick={() => setOpen(true)}>
        Actions
      </button>
    )
  }

  const needsReason = ['RETURN', 'PAUSE', 'FUND'].some(() => true)

  return (
    <div className="grid gap-2">
      {needsReason && (
        <input
          className="field text-sm"
          placeholder="Reason / notes"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {state === 'SUBMITTED' && (
          <>
            <button
              type="button"
              className="btn btn-primary text-sm"
              disabled={pending}
              onClick={() => run(() => opsApproveCampaign(campaignId))}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn btn-secondary text-sm"
              disabled={pending || reason.trim().length === 0}
              onClick={() => run(() => opsReturnCampaign(campaignId, reason))}
            >
              Return
            </button>
          </>
        )}

        {state === 'AWAITING_FUNDS' && (
          <button
            type="button"
            className="btn btn-secondary text-sm"
            disabled={pending || reason.trim().length === 0}
            onClick={() => run(() => opsFundCampaign(campaignId, reason))}
          >
            Mark invoice funded
          </button>
        )}

        {['LIVE', 'FILLING', 'FUNDED'].includes(state) && (
          <button
            type="button"
            className="btn btn-secondary text-sm text-[var(--color-red)]"
            disabled={pending || reason.trim().length === 0}
            onClick={() => run(() => opsPauseCampaign(campaignId, reason))}
          >
            Pause
          </button>
        )}

        {['EXHAUSTED', 'EXPIRED', 'PAUSED'].includes(state) && (
          <button
            type="button"
            className="btn btn-secondary text-sm"
            disabled={pending}
            onClick={() => run(() => opsReconcileCampaign(campaignId))}
          >
            Reconcile
          </button>
        )}

        {state === 'RECONCILING' && (
          <>
            <button
              type="button"
              className="btn btn-primary text-sm"
              disabled={pending}
              onClick={() => run(() => opsCloseCampaign(campaignId, 'refund'))}
            >
              Close + refund
            </button>
            <button
              type="button"
              className="btn btn-secondary text-sm"
              disabled={pending}
              onClick={() => run(() => opsCloseCampaign(campaignId, 'rollover'))}
            >
              Close + rollover
            </button>
          </>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
