'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { approvePlacement, regeneratePlacement, rejectPlacement } from '@/app/(participant)/actions'
import { EVENTS, track } from '@/lib/analytics'
import { mediaUrl } from '@/lib/media-url'

type Asset = { id: string; name: string }

/**
 * P-05 participant review — docs/02 A3: before/after slider, then
 * Approve · Regenerate (counter) · Move · Swap product · Reject.
 *
 * This is the screen the whole product turns on: nothing publishes without it.
 */
export function ReviewStep({
  placementId,
  beforePath,
  afterPath,
  regensLeft,
  assets,
}: {
  placementId: string
  beforePath: string | null
  afterPath: string | null
  regensLeft: number
  assets: Asset[]
}) {
  const t = useTranslations('placement.review')
  const router = useRouter()

  const [slider, setSlider] = useState(60)
  const [pending, setPending] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setPending(true)
    setError(null)
    const result = await fn()
    setPending(false)
    if (result.ok) router.refresh()
    else setError(result.error ?? 'error')
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg mb-4">{t('title')}</h2>

      {/* Before/after: the "after" is clipped to the slider position over the "before". */}
      <div className="relative w-full aspect-[4/5] rounded-lg overflow-hidden bg-[var(--color-bg)] mb-2">
        {beforePath && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl(beforePath)} alt={t('before')} className="absolute inset-0 w-full h-full object-contain" />
        )}
        {afterPath && (
          <div className="absolute inset-0 overflow-hidden" style={{ width: `${slider}%` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaUrl(afterPath)}
              alt={t('after')}
              className="h-full object-contain"
              style={{ width: `${(100 / slider) * 100}%`, maxWidth: 'none' }}
            />
          </div>
        )}
        <div
          className="absolute inset-y-0 w-0.5 bg-[var(--color-orange)] pointer-events-none"
          style={{ left: `${slider}%` }}
          aria-hidden="true"
        />
      </div>

      <label className="sr-only" htmlFor="ba-slider">
        {t('before')} / {t('after')}
      </label>
      <input
        id="ba-slider"
        type="range"
        min={0}
        max={100}
        value={slider}
        onChange={(e) => setSlider(Number(e.target.value))}
        className="w-full accent-[var(--color-orange)] mb-5"
      />

      <div className="grid gap-2">
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={pending}
          onClick={() =>
            run(async () => {
              track(EVENTS.placementApproved, { placement_id: placementId })
              return approvePlacement(placementId)
            })
          }
        >
          {t('approve')}
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending || regensLeft <= 0}
            onClick={() =>
              run(async () => {
                track(EVENTS.placementRegenerated, { placement_id: placementId, kind: 'REGEN' })
                return regeneratePlacement({ placementId, kind: 'REGEN' })
              })
            }
          >
            {t('regenerate')} · {t('regensLeft', { count: regensLeft })}
          </button>

          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending || regensLeft <= 0}
            onClick={() => run(() => regeneratePlacement({ placementId, kind: 'MOVE' }))}
          >
            {t('move')}
          </button>
        </div>

        {assets.length > 1 && (
          <select
            className="field"
            disabled={pending || regensLeft <= 0}
            defaultValue=""
            onChange={(e) => {
              if (!e.target.value) return
              void run(() => regeneratePlacement({ placementId, kind: 'SWAP', assetId: e.target.value }))
            }}
          >
            <option value="">{t('swap')}</option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        )}

        {rejecting ? (
          <div className="grid gap-2">
            <label className="label" htmlFor="reject-reason">
              {t('rejectReason')}
            </label>
            <textarea
              id="reject-reason"
              className="field"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-secondary text-[var(--color-red)]"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  track(EVENTS.placementRejected, { placement_id: placementId })
                  return rejectPlacement(placementId, reason)
                })
              }
            >
              {t('reject')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-secondary text-[var(--color-red)]"
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            {t('reject')}
          </button>
        )}
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
