'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { approvePlacementAsBrand, rejectPlacementAsBrand } from '@/app/(brand)/actions'
import { mediaUrl } from '@/lib/media-url'
import { Countdown } from '@/components/Countdown'

/**
 * One placement in the Tier B queue. A rejection needs a written reason: the first
 * rejection bounces the placement back to the participant to fix, so a bare "no" would
 * be useless to them (docs/03 P-06).
 */
export function BrandReviewCard({
  placementId,
  handle,
  versionPath,
  deadline,
}: {
  placementId: string
  handle: string
  versionPath: string | null
  deadline: string
}) {
  const t = useTranslations('brandApp')
  const router = useRouter()

  const [pending, setPending] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  const run = async (fn: () => Promise<{ ok: boolean }>) => {
    setPending(true)
    await fn()
    setPending(false)
    router.refresh()
  }

  return (
    <div className="card p-4">
      {versionPath && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mediaUrl(versionPath)}
          alt=""
          className="w-full rounded-lg mb-3 aspect-[4/5] object-contain bg-[var(--color-bg)]"
        />
      )}

      <div className="flex items-center justify-between mb-3 text-sm">
        <span className="font-semibold">@{handle}</span>
        <Countdown to={deadline} className="text-xs text-[var(--color-ink-3)]" />
      </div>

      {rejecting ? (
        <div className="grid gap-2">
          <textarea
            className="field"
            rows={2}
            placeholder={t('reject')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary text-[var(--color-red)] text-sm"
            disabled={pending || reason.trim().length === 0}
            onClick={() => run(() => rejectPlacementAsBrand(placementId, reason))}
          >
            {t('reject')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="btn text-white text-sm"
            style={{ background: 'var(--color-blue)' }}
            disabled={pending}
            onClick={() => run(() => approvePlacementAsBrand(placementId))}
          >
            {t('approve')}
          </button>
          <button
            type="button"
            className="btn btn-secondary text-sm"
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            {t('reject')}
          </button>
        </div>
      )}
    </div>
  )
}
