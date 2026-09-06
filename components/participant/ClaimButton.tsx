'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { claimCampaign } from '@/app/(participant)/actions'
import { EVENTS, track } from '@/lib/analytics'

type Account = { id: string; handle: string; platform: string; avgViews30d: number }

/** Claim with an account picker — docs/02 A3 "Claim: pick account". */
export function ClaimButton({
  campaignId,
  accounts,
  defaultAccountId,
  estimateLabel,
}: {
  campaignId: string
  accounts: Account[]
  defaultAccountId: string
  estimateLabel: string
}) {
  const t = useTranslations('campaigns')
  const td = useTranslations('campaigns.detail')
  const router = useRouter()

  const [accountId, setAccountId] = useState(defaultAccountId)
  const [contentType, setContentType] = useState<'story' | 'reel' | 'post'>('story')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onClaim() {
    setPending(true)
    setError(null)
    track(EVENTS.claimStarted, { campaign_id: campaignId, content_type: contentType })

    const result = await claimCampaign({ campaignId, socialAccountId: accountId, contentType })
    setPending(false)

    if (result.ok && result.data) {
      track(EVENTS.claimCompleted, { campaign_id: campaignId })
      router.push(`/placements/${result.data.placementId}`)
    } else if (!result.ok) {
      setError(result.error)
    }
  }

  return (
    <div className="card p-4 grid gap-3">
      {accounts.length > 1 && (
        <div>
          <label className="label" htmlFor="claim-account">
            {td('claimWith')}
          </label>
          <select
            id="claim-account"
            className="field"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.handle} · {a.avgViews30d.toLocaleString('sv-SE')}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="label" htmlFor="claim-type">
          {td('contentTypes')}
        </label>
        <select
          id="claim-type"
          className="field"
          value={contentType}
          onChange={(e) => setContentType(e.target.value as 'story' | 'reel' | 'post')}
        >
          <option value="story">Story</option>
          <option value="reel">Reel</option>
          <option value="post">Post</option>
        </select>
      </div>

      {error && (
        <p className="error-text" role="alert">
          {t(`reasons.${error}` as never, { min: '', cities: '' })}
        </p>
      )}

      <button type="button" className="btn btn-primary w-full" onClick={onClaim} disabled={pending}>
        {td('claim')} · {estimateLabel}
      </button>
    </div>
  )
}
