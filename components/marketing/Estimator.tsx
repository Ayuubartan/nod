'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { estimateParticipantOre, formatKrDown } from '@/lib/money/calc'
import { ESTIMATOR_EXAMPLE_VIEWS, ESTIMATOR_RANGE } from '@/lib/money/rates'
import { bucket, EVENTS, FOLLOWER_BUCKETS, track, VIEW_BUCKETS } from '@/lib/analytics'

/**
 * Earnings estimator — docs/01 section 3.
 *
 * Reads rates from lib/money/rates.ts and computes with the same functions the real
 * payout uses, so the number a participant sees here can never drift from what they
 * are actually paid. Nothing on this component is hardcoded.
 */
export function Estimator() {
  const t = useTranslations('marketing.estimator')
  const [platform, setPlatform] = useState<'INSTAGRAM' | 'TIKTOK'>('INSTAGRAM')
  const [followers, setFollowers] = useState(800)
  // Prefilled at ~55% of followers (docs/01), until the user moves the slider.
  const [views, setViews] = useState<number | null>(null)

  const effectiveViews = views ?? Math.round(followers * 0.55)

  const { low, high } = useMemo(
    () => ({
      low: estimateParticipantOre(ESTIMATOR_RANGE.low, effectiveViews),
      high: estimateParticipantOre(ESTIMATOR_RANGE.high, effectiveViews),
    }),
    [effectiveViews],
  )

  const examples = useMemo(
    () =>
      ESTIMATOR_EXAMPLE_VIEWS.map((v) => ({
        views: v,
        ore: estimateParticipantOre(ESTIMATOR_RANGE.high, v),
      })),
    [],
  )

  const report = (next: Partial<{ followers: number; views: number }>) => {
    track(EVENTS.estimatorUsed, {
      platform,
      followers_bucket: bucket(next.followers ?? followers, FOLLOWER_BUCKETS),
      views_bucket: bucket(next.views ?? effectiveViews, VIEW_BUCKETS),
    })
  }

  return (
    <section className="section" id="estimator">
      <div className="wrap">
        <h2 className="text-2xl sm:text-3xl mb-6">{t('title')}</h2>

        <div className="card p-5 sm:p-6">
          <fieldset className="mb-5">
            <legend className="label">{t('platform')}</legend>
            <div className="flex gap-2">
              {(['INSTAGRAM', 'TIKTOK'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className="chip"
                  aria-pressed={platform === p}
                  onClick={() => setPlatform(p)}
                >
                  {p === 'INSTAGRAM' ? t('instagram') : t('tiktok')}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="est-followers">
                {t('followers')}: <span className="tabular">{followers.toLocaleString('sv-SE')}</span>
              </label>
              <input
                id="est-followers"
                type="range"
                min={100}
                max={20_000}
                step={100}
                value={followers}
                className="w-full accent-[var(--color-amber)]"
                onChange={(e) => setFollowers(Number(e.target.value))}
                onPointerUp={() => report({ followers })}
              />
            </div>

            <div>
              <label className="label" htmlFor="est-views">
                {t('avgViews')}: <span className="tabular">{effectiveViews.toLocaleString('sv-SE')}</span>
              </label>
              <input
                id="est-views"
                type="range"
                min={50}
                max={10_000}
                step={50}
                value={effectiveViews}
                className="w-full accent-[var(--color-amber)]"
                onChange={(e) => setViews(Number(e.target.value))}
                onPointerUp={() => report({ views: effectiveViews })}
              />
            </div>
          </div>

          <p
            className="mt-6 text-2xl sm:text-3xl font-[family-name:var(--font-display)] font-extrabold"
            aria-live="polite"
          >
            {t('result', {
              low: Math.floor(low / 100).toLocaleString('sv-SE'),
              high: Math.floor(high / 100).toLocaleString('sv-SE'),
            })}
          </p>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">{t('note')}</p>
        </div>

        <div className="mt-6">
          <h3 className="text-sm font-semibold text-[var(--color-ink-2)] mb-3">{t('examplesTitle')}</h3>
          <ul className="grid gap-2 sm:grid-cols-3">
            {examples.map((row) => (
              <li key={row.views} className="card px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-[var(--color-ink-2)]">
                  {t('exampleRow', { views: row.views.toLocaleString('sv-SE') })}
                </span>
                <span className="amount font-semibold">{formatKrDown(row.ore)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
