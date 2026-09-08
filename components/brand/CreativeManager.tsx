'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { replaceCampaignAsset, retireCampaignAsset } from '@/app/(brand)/actions'
import { mediaUrl } from '@/lib/media-url'

export type CreativeItem = {
  id: string
  name: string
  storagePath: string
  placementTypes: string[]
  inFlight: number
}

/**
 * The distribution-layer control: every live asset, how many placements are still being
 * made with it, and the swap that re-renders those with a different asset. Approved
 * images are never touched (lib/creative.ts).
 */
export function CreativeManager({ campaignId, assets }: { campaignId: string; assets: CreativeItem[] }) {
  const t = useTranslations('brandApp.creativeSection')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const errorText = (code: string) => {
    if (code === 'inFlight') return t('errInFlight')
    if (code === 'lastAsset' || code === 'LAST_ASSET') return t('errLastAsset')
    return code
  }

  const replace = (fromAssetId: string) => {
    const toAssetId = choice[fromAssetId]
    if (!toAssetId) return
    setBusyId(fromAssetId)
    setNotice(null)
    startTransition(async () => {
      const result = await replaceCampaignAsset({ campaignId, fromAssetId, toAssetId })
      setBusyId(null)
      if (result.ok) {
        const parts = [t('replaced', { count: result.data?.reRendered ?? 0 })]
        if (result.data?.deferred) parts.push(t('deferred', { count: result.data.deferred }))
        setNotice({ tone: 'ok', text: parts.join(' · ') })
        router.refresh()
      } else {
        setNotice({ tone: 'error', text: errorText(result.error) })
      }
    })
  }

  const retire = (assetId: string) => {
    setBusyId(assetId)
    setNotice(null)
    startTransition(async () => {
      const result = await retireCampaignAsset(campaignId, assetId)
      setBusyId(null)
      if (result.ok) {
        setNotice({ tone: 'ok', text: t('retired') })
        router.refresh()
      } else {
        setNotice({ tone: 'error', text: errorText(result.error) })
      }
    })
  }

  if (assets.length === 0) {
    return <p className="card p-8 text-center text-sm text-[var(--color-ink-3)]">{t('none')}</p>
  }

  return (
    <div className="grid gap-3">
      {notice && (
        <p
          className={`rounded-lg px-3 py-2 text-sm ${
            notice.tone === 'ok' ? 'bg-[var(--color-green)] text-white' : 'bg-[var(--color-red)] text-white'
          }`}
          role="status"
        >
          {notice.text}
        </p>
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {assets.map((asset) => {
          const others = assets.filter((a) => a.id !== asset.id)
          const busy = pending && busyId === asset.id
          return (
            <li key={asset.id} className="card p-4 grid gap-3">
              <div className="flex gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaUrl(asset.storagePath)}
                  alt={asset.name}
                  className="w-24 h-24 shrink-0 object-contain bg-[var(--color-bg)] rounded"
                />
                <div className="min-w-0">
                  <p className="font-medium truncate">{asset.name}</p>
                  <p className="text-xs text-[var(--color-ink-3)]">{asset.placementTypes.join(', ') || '—'}</p>
                  <p className="text-xs mt-2 tabular">
                    <span
                      className={`chip text-xs ${asset.inFlight > 0 ? 'bg-[var(--color-orange)] text-[#111820]' : ''}`}
                    >
                      {t('inFlight', { count: asset.inFlight })}
                    </span>
                  </p>
                </div>
              </div>

              {others.length > 0 && (
                <div className="flex gap-2">
                  <select
                    className="field text-sm flex-1"
                    value={choice[asset.id] ?? ''}
                    onChange={(e) => setChoice((c) => ({ ...c, [asset.id]: e.target.value }))}
                    aria-label={t('replaceWith')}
                  >
                    <option value="">{t('replaceWith')}</option>
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn text-white text-sm"
                    style={{ background: 'var(--color-blue)' }}
                    disabled={busy || !choice[asset.id]}
                    onClick={() => replace(asset.id)}
                  >
                    {t('replace')}
                  </button>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  type="button"
                  className="text-xs text-[var(--color-ink-2)] underline disabled:opacity-40"
                  disabled={busy || asset.inFlight > 0 || others.length === 0}
                  title={asset.inFlight > 0 ? t('errInFlight') : others.length === 0 ? t('errLastAsset') : undefined}
                  onClick={() => retire(asset.id)}
                >
                  {t('retire')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-xs text-[var(--color-ink-3)]">{t('locked')}</p>
    </div>
  )
}
