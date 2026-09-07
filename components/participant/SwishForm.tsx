'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { updateSwishNumber } from '@/app/(participant)/actions'

/**
 * Swish number entry, shared by settings and the wallet. Onboarding no longer asks for
 * it (see completeOnboarding), so the wallet shows this the moment there is a balance
 * and no number on file.
 */
export function SwishForm({ maskedSwish, primary = false }: { maskedSwish: string | null; primary?: boolean }) {
  const common = useTranslations('common')
  const payout = useTranslations('onboarding.payout')
  const router = useRouter()

  const [swish, setSwish] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSave() {
    setPending(true)
    const result = await updateSwishNumber(swish)
    setPending(false)
    if (result.ok) {
      setSwish('')
      setError(null)
      router.refresh()
    } else {
      setError(result.error === 'invalidSwish' ? payout('invalid') : result.error)
    }
  }

  return (
    <div>
      {maskedSwish && <p className="text-sm tabular mb-2">{maskedSwish}</p>}
      <input
        className="field mb-2"
        inputMode="tel"
        placeholder="070-123 45 67"
        aria-label={payout('swish')}
        value={swish}
        onChange={(e) => setSwish(e.target.value)}
      />
      {error && <p className="error-text mb-2">{error}</p>}
      <button
        type="button"
        className={`btn ${primary ? 'btn-primary' : 'btn-secondary'} w-full text-sm`}
        disabled={pending || swish.length < 6}
        onClick={onSave}
      >
        {common('save')}
      </button>
    </div>
  )
}
