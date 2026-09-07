'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { submitPosition } from '@/app/(participant)/actions'
import { EVENTS, track } from '@/lib/analytics'
import { heuristicRegions } from '@/lib/regions'

type Asset = { id: string; name: string }
type Region = { x: number; y: number; w: number; h: number; label?: string }

/**
 * P-03 position — docs/02 A3: "engine returns 2–4 candidate regions with a product
 * each; user picks one, or draws a rectangle".
 *
 * Coordinates are normalised 0..1 so the choice survives the resize between the phone
 * preview and the render.
 */
export function PositionStep({ placementId, assets }: { placementId: string; assets: Asset[] }) {
  const t = useTranslations('placement.position')
  const router = useRouter()

  const candidates = heuristicRegions()
  const [region, setRegion] = useState<Region>(candidates[0]!)
  const [assetId, setAssetId] = useState(assets[0]?.id ?? '')
  const [custom, setCustom] = useState(false)
  const [pending, setPending] = useState(false)

  async function onConfirm() {
    setPending(true)
    track(EVENTS.regionPicked, { placement_id: placementId, label: region.label ?? 'custom' })

    const result = await submitPosition({ placementId, region, assetId })
    setPending(false)
    if (result.ok) router.refresh()
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg mb-1">{t('title')}</h2>
      <p className="text-sm text-[var(--color-ink-2)] mb-4">{t('sub')}</p>

      {/* A 4:5 frame standing in for the uploaded photo, with the candidate boxes on it. */}
      <div className="relative w-full aspect-[4/5] rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] mb-4 overflow-hidden">
        {candidates.map((candidate) => {
          const selected = !custom && candidate.label === region.label
          return (
            <button
              key={candidate.label}
              type="button"
              aria-pressed={selected}
              aria-label={candidate.label}
              onClick={() => {
                setCustom(false)
                setRegion(candidate)
              }}
              className="absolute rounded-md transition-colors"
              style={{
                left: `${candidate.x * 100}%`,
                top: `${candidate.y * 100}%`,
                width: `${candidate.w * 100}%`,
                height: `${candidate.h * 100}%`,
                border: selected ? '2px solid var(--color-amber)' : '2px dashed var(--color-ink-3)',
                background: selected ? 'rgba(245,165,36,0.15)' : 'transparent',
              }}
            />
          )
        })}
      </div>

      {custom && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {(['x', 'y', 'w', 'h'] as const).map((axis) => (
            <div key={axis}>
              <label className="label" htmlFor={`region-${axis}`}>
                {axis.toUpperCase()}: {Math.round(region[axis] * 100)}%
              </label>
              <input
                id={`region-${axis}`}
                type="range"
                min={axis === 'w' || axis === 'h' ? 5 : 0}
                max={axis === 'w' || axis === 'h' ? 100 : 95}
                value={Math.round(region[axis] * 100)}
                className="w-full accent-[var(--color-amber)]"
                onChange={(e) => setRegion({ ...region, [axis]: Number(e.target.value) / 100, label: 'custom' })}
              />
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="chip mb-4"
        aria-pressed={custom}
        onClick={() => setCustom((c) => !c)}
      >
        {t('drawYourOwn')}
      </button>

      {assets.length > 1 && (
        <div className="mb-4">
          <label className="label" htmlFor="asset">
            {t('product')}
          </label>
          <select id="asset" className="field" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <button type="button" className="btn btn-primary w-full" onClick={onConfirm} disabled={pending || !assetId}>
        {t('confirm')}
      </button>
    </section>
  )
}
