'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { submitClipPost } from '@/app/(participant)/actions'
import { formatKrDown } from '@/lib/money/calc'

/**
 * Submit a post URL — docs/14 §1 (S-01). The success line says exactly what was
 * reserved, or that nothing was because the budget is spent (D2). No invented numbers.
 */
export function SubmitClipForm({ campaignId }: { campaignId: string }) {
  const t = useTranslations('clips.detail')
  const te = useTranslations('clips.submitErrors')
  const locale = useLocale()
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ reservationOre: number; budgetExhausted: boolean } | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    setDone(null)
    const result = await submitClipPost({ campaignId, url })
    setPending(false)
    if (result.ok && result.data) {
      setDone(result.data)
      setUrl('')
      router.refresh()
    } else if (!result.ok) {
      setError(result.error)
    }
  }

  return (
    <form onSubmit={onSubmit} className="card p-4 grid gap-3">
      <div>
        <h2 className="label">{t('submit')}</h2>
        <p className="text-xs text-[var(--color-ink-2)]">{t('submitHint')}</p>
      </div>
      <input
        type="url"
        inputMode="url"
        autoComplete="off"
        className="field"
        placeholder={t('urlPlaceholder')}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
        aria-label={t('submit')}
      />
      <button type="submit" className="btn btn-primary" disabled={pending || url.trim().length < 10}>
        {t('submitButton')}
      </button>
      {error && (
        <p className="error-text" role="alert">
          {te.has(error) ? te(error) : te('submitFailed')}
        </p>
      )}
      {done && (
        <p className="text-sm text-[var(--color-green)]" role="status">
          {done.budgetExhausted || done.reservationOre === 0
            ? t('reservedNone')
            : t('reserved', { amount: formatKrDown(done.reservationOre, locale) })}
        </p>
      )}
    </form>
  )
}
