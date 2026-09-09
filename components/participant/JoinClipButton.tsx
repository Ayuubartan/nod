'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { joinClipCampaign, leaveClipCampaign } from '@/app/(participant)/actions'

/**
 * Join / leave a clip campaign — docs/14 §1 (M-01, M-02). Joining calls no provider and
 * reserves nothing; the row simply says "this creator intends to post". The leave
 * button stays low-key because clips already in flight are unaffected.
 */
export function JoinClipButton({ campaignId, joined }: { campaignId: string; joined: boolean }) {
  const t = useTranslations('clips.detail')
  const te = useTranslations('clips.joinErrors')
  const locale = useLocale()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setPending(true)
    setError(null)
    const result = await fn()
    setPending(false)
    if (result.ok) router.refresh()
    else setError(result.error ?? 'invalid')
  }

  const errorText = (code: string) => (te.has(code) ? te(code) : te('invalid'))

  if (joined) {
    return (
      <div className="text-sm">
        <p className="font-semibold text-[var(--color-green)]">✓ {t('joined')}</p>
        <button
          type="button"
          className="text-xs underline text-[var(--color-ink-3)] mt-1"
          disabled={pending}
          onClick={() => run(() => leaveClipCampaign(campaignId))}
        >
          {t('leave')}
        </button>
        <p className="text-[11px] text-[var(--color-ink-3)] mt-0.5">{t('leaveHint')}</p>
        {error && (
          <p className="error-text mt-2" role="alert" lang={locale}>
            {errorText(error)}
          </p>
        )}
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        className="btn btn-primary w-full"
        disabled={pending}
        onClick={() => run(() => joinClipCampaign(campaignId))}
      >
        {t('join')}
      </button>
      {error && (
        <p className="error-text mt-2" role="alert">
          {errorText(error)}
        </p>
      )}
    </div>
  )
}
