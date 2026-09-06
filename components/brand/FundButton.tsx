'use client'

import { useState } from 'react'
import { startCheckout } from '@/app/(brand)/actions'

/** Opens Stripe Checkout. The webhook, not this button, marks the campaign FUNDED. */
export function FundButton({ campaignId }: { campaignId: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div>
      <button
        type="button"
        className="btn text-white text-sm"
        style={{ background: 'var(--color-blue)' }}
        disabled={pending}
        onClick={async () => {
          setPending(true)
          const result = await startCheckout(campaignId)
          setPending(false)
          if (result.ok && result.data) window.location.href = result.data.url
          else if (!result.ok) setError(result.error)
        }}
      >
        Fund
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
