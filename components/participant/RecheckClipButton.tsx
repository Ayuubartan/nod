'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { recheckClipSubmission } from '@/app/(participant)/actions'

/** "I added the disclosure" — re-runs the caption check inside the 24 h fix window. */
export function RecheckClipButton({ submissionId }: { submissionId: string }) {
  const t = useTranslations('clips.row')
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null)

  async function onClick() {
    setPending(true)
    setMessage(null)
    const result = await recheckClipSubmission(submissionId)
    setPending(false)
    if (!result.ok) {
      const key = `recheckErrors.${result.error}`
      setMessage({ tone: 'error', text: t.has(key) ? t(key) : t('recheckErrors.notFixable') })
      return
    }
    const outcome = result.data?.outcome
    if (outcome === 'tracking') setMessage({ tone: 'ok', text: t('recheckOk') })
    else if (outcome === 'fix_disclosure') setMessage({ tone: 'warn', text: t('recheckStillMissing') })
    router.refresh()
  }

  return (
    <div className="mt-2">
      <button type="button" className="btn btn-secondary text-sm" disabled={pending} onClick={onClick}>
        {pending ? t('rechecking') : t('recheck')}
      </button>
      {message && (
        <p
          className={`text-xs mt-1 ${message.tone === 'ok' ? 'text-[var(--color-green)]' : message.tone === 'error' ? 'error-text' : 'text-[var(--color-ink-2)]'}`}
          role="status"
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
