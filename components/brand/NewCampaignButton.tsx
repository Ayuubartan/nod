'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createDraft } from '@/app/(brand)/actions'

export function NewCampaignButton({ brandId, label }: { brandId: string; label: string }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  return (
    <button
      type="button"
      className="btn text-white text-sm"
      style={{ background: 'var(--color-blue)' }}
      disabled={pending}
      onClick={async () => {
        setPending(true)
        const result = await createDraft(brandId, 'Untitled campaign')
        setPending(false)
        if (result.ok && result.data) router.push(`/brand/campaigns/${result.data.id}/edit`)
      }}
    >
      {label}
    </button>
  )
}
