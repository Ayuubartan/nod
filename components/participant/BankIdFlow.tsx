'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { completeBankId, startBankId } from '@/app/(participant)/actions'
import { EVENTS, track } from '@/lib/analytics'

/**
 * Same-device on mobile, QR on desktop (docs/06 section 3). With the sandbox provider
 * the returned URL lands straight back on the callback, so the whole flow is testable
 * without a real BankID app.
 */
export function BankIdFlow() {
  const t = useTranslations('verify')
  const router = useRouter()

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onStart() {
    setPending(true)
    setError(null)
    track(EVENTS.bankidStarted, {})

    const started = await startBankId(`${window.location.origin}/verify/callback`)
    if (!started.ok) {
      setPending(false)
      setError(started.error)
      return
    }

    const url = new URL(started.data!.url, window.location.origin)

    // A real broker takes over the window; the sandbox returns a local callback URL,
    // which we can complete in place.
    if (url.origin !== window.location.origin) {
      window.location.href = url.toString()
      return
    }

    const payload = Object.fromEntries(url.searchParams.entries())
    const completed = await completeBankId(payload)
    setPending(false)

    if (completed.ok) {
      track(EVENTS.bankidCompleted, {})
      router.push('/campaigns')
      router.refresh()
    } else {
      setError(completed.error)
    }
  }

  return (
    <div className="card p-5 grid gap-4">
      {error && (
        <p className="error-text" role="alert">
          {error === 'under18' ? t('under18') : error === 'duplicate' ? t('duplicate') : t('failed')}
        </p>
      )}

      <button type="button" className="btn btn-primary w-full" onClick={onStart} disabled={pending}>
        {pending ? t('waiting') : t('start')}
      </button>

      <p className="text-xs text-[var(--color-ink-3)] text-center">{t('qrHint')}</p>
    </div>
  )
}
