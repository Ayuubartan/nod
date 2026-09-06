'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsSetInvoiceWhitelist } from '@/app/(ops)/actions'

/**
 * Whitelisting lets a campaign go FUNDED on ops approval before the invoice cash
 * arrives (docs/06 section 4). It is per-brand and deliberately explicit.
 */
export function InvoiceWhitelistToggle({ brandId, whitelisted }: { brandId: string; whitelisted: boolean }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={whitelisted}
        disabled={pending}
        className="size-4 accent-[var(--color-amber)]"
        onChange={async (e) => {
          setPending(true)
          await opsSetInvoiceWhitelist(brandId, e.target.checked)
          setPending(false)
          router.refresh()
        }}
      />
      Invoice whitelisted
    </label>
  )
}
