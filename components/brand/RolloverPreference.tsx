'use client'

import { useState } from 'react'
import { setRolloverPreference } from '@/app/(brand)/actions'

/** Refund or roll over unspent budget when a campaign closes (docs/03 section 4). */
export function RolloverPreference({
  brandId,
  preference,
}: {
  brandId: string
  preference: 'refund' | 'rollover'
}) {
  const [value, setValue] = useState(preference)
  const [pending, setPending] = useState(false)

  return (
    <div className="card p-4 flex flex-wrap gap-2">
      {(['refund', 'rollover'] as const).map((option) => (
        <button
          key={option}
          type="button"
          className="chip"
          aria-pressed={value === option}
          disabled={pending}
          onClick={async () => {
            setValue(option)
            setPending(true)
            await setRolloverPreference(brandId, option)
            setPending(false)
          }}
        >
          {option === 'refund' ? 'Refund to card' : 'Roll over to the next campaign'}
        </button>
      ))}
    </div>
  )
}
