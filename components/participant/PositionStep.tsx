'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { submitPosition } from '@/app/(participant)/actions'
import { EVENTS, track } from '@/lib/analytics'
import { mediaUrl } from '@/lib/media-url'
import { heuristicRegions } from '@/lib/regions'

type Asset = { id: string; name: string; storagePath: string }
type Region = { x: number; y: number; w: number; h: number; label?: string }

const MIN = 0.08

/**
 * P-03 position — docs/02 A3: "engine returns 2–4 candidate regions with a product
 * each; user picks one, or draws a rectangle".
 *
 * The participant's own photo is the canvas. Tap a suggested surface, or drag the box
 * anywhere; the chosen product is previewed inside it so what they confirm is roughly
 * what the composite will look like. Coordinates are normalised 0..1 so the choice
 * survives the resize between the phone preview and the render.
 */
export function PositionStep({
  placementId,
  originalPath,
  assets,
}: {
  placementId: string
  originalPath: string | null
  assets: Asset[]
}) {
  const t = useTranslations('placement.position')
  const router = useRouter()
  const frameRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const candidates = heuristicRegions()
  const [region, setRegion] = useState<Region>(candidates[0]!)
  const [assetId, setAssetId] = useState(assets[0]?.id ?? '')
  const [custom, setCustom] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const asset = assets.find((a) => a.id === assetId) ?? null

  /** Pointer position as a 0..1 fraction of the frame. */
  const fraction = (e: React.PointerEvent) => {
    const rect = frameRef.current!.getBoundingClientRect()
    return { fx: (e.clientX - rect.left) / rect.width, fy: (e.clientY - rect.top) / rect.height }
  }

  const clamp = (r: Region): Region => ({
    ...r,
    w: Math.min(1, Math.max(MIN, r.w)),
    h: Math.min(1, Math.max(MIN, r.h)),
    x: Math.min(1 - Math.max(MIN, r.w), Math.max(0, r.x)),
    y: Math.min(1 - Math.max(MIN, r.h), Math.max(0, r.y)),
  })

  const onPointerDown = (e: React.PointerEvent) => {
    const { fx, fy } = fraction(e)
    drag.current = { dx: fx - region.x, dy: fy - region.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const { fx, fy } = fraction(e)
    setCustom(true)
    setRegion(clamp({ ...region, x: fx - drag.current.dx, y: fy - drag.current.dy, label: 'custom' }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  async function onConfirm() {
    setPending(true)
    setError(null)
    track(EVENTS.regionPicked, { placement_id: placementId, label: region.label ?? 'custom' })

    const result = await submitPosition({ placementId, region, assetId })
    if (result.ok) {
      router.refresh()
    } else {
      setPending(false)
      setError(result.error)
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg mb-1">{t('title')}</h2>
      <p className="text-sm text-[var(--color-ink-2)] mb-4">{t('sub')}</p>

      <div
        ref={frameRef}
        className="relative w-full aspect-[4/5] rounded-lg bg-[var(--color-bg)] border border-[var(--color-line)] mb-2 overflow-hidden select-none touch-none"
      >
        {originalPath && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl(originalPath)}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          />
        )}

        {candidates.map((candidate) => {
          const selected = !custom && candidate.label === region.label
          if (selected) return null
          return (
            <button
              key={candidate.label}
              type="button"
              aria-label={candidate.label}
              onClick={() => {
                setCustom(false)
                setRegion(candidate)
              }}
              className="absolute rounded-md"
              style={{
                left: `${candidate.x * 100}%`,
                top: `${candidate.y * 100}%`,
                width: `${candidate.w * 100}%`,
                height: `${candidate.h * 100}%`,
                border: '2px dashed rgba(255,255,255,0.85)',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
              }}
            />
          )
        })}

        {/* The live box: draggable, with the product previewed where it will land. */}
        <div
          role="slider"
          aria-label={region.label ?? 'custom'}
          aria-valuenow={Math.round(region.x * 100)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="absolute rounded-md cursor-grab active:cursor-grabbing flex items-end justify-center"
          style={{
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
            width: `${region.w * 100}%`,
            height: `${region.h * 100}%`,
            border: '2px solid var(--color-amber)',
            background: 'rgba(245,165,36,0.12)',
            boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
          }}
        >
          {asset && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={mediaUrl(asset.storagePath)}
              alt={asset.name}
              draggable={false}
              className="max-w-[86%] max-h-[86%] object-contain pointer-events-none drop-shadow-md"
            />
          )}
        </div>
      </div>
      <p className="text-xs text-[var(--color-ink-3)] mb-4">{t('dragHint')}</p>

      <button type="button" className="chip mb-4" aria-pressed={custom} onClick={() => setCustom((c) => !c)}>
        {t('drawYourOwn')}
      </button>

      {custom && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {(['w', 'h'] as const).map((axis) => (
            <div key={axis}>
              <label className="label" htmlFor={`region-${axis}`}>
                {axis.toUpperCase()}: {Math.round(region[axis] * 100)}%
              </label>
              <input
                id={`region-${axis}`}
                type="range"
                min={MIN * 100}
                max={100}
                value={Math.round(region[axis] * 100)}
                className="w-full accent-[var(--color-amber)]"
                onChange={(e) =>
                  setRegion(clamp({ ...region, [axis]: Number(e.target.value) / 100, label: 'custom' }))
                }
              />
            </div>
          ))}
        </div>
      )}

      {assets.length > 1 && (
        <div className="mb-4">
          <label className="label" htmlFor="asset">
            {t('product')}
          </label>
          <select id="asset" className="field" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <button type="button" className="btn btn-primary w-full" onClick={onConfirm} disabled={pending || !assetId}>
        {pending ? t('rendering') : t('confirm')}
      </button>
      {error && <p className="error-text mt-2">{error}</p>}
    </section>
  )
}
