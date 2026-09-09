'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsSetCampaignPause } from '@/app/(ops)/actions'

/**
 * Pause / resume joins and submissions on a clip campaign (docs/14 §6). These are doors,
 * not states: tracking and settlement of what is already in continue regardless.
 */
export function ClipCampaignControls({
  campaignId,
  joinsPaused,
  submissionsPaused,
}: {
  campaignId: string
  joinsPaused: boolean
  submissionsPaused: boolean
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (input: { joins?: boolean; submissions?: boolean }) => {
    setPending(true)
    setError(null)
    const result = await opsSetCampaignPause({ campaignId, reason, ...input })
    setPending(false)
    if (result.ok) {
      setReason('')
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  const ready = reason.trim().length >= 3 && !pending

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <input
        className="field text-xs flex-1 min-w-40"
        placeholder="Reason (audited)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="button" className="btn btn-secondary text-xs" disabled={!ready} onClick={() => run({ joins: !joinsPaused })}>
        {joinsPaused ? 'Resume joins' : 'Pause joins'}
      </button>
      <button
        type="button"
        className="btn btn-secondary text-xs"
        disabled={!ready}
        onClick={() => run({ submissions: !submissionsPaused })}
      >
        {submissionsPaused ? 'Resume submissions' : 'Pause submissions'}
      </button>
      {error && <p className="text-xs text-[var(--color-red)] w-full">{error}</p>}
    </div>
  )
}
