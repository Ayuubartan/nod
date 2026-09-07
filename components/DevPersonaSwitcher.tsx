'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { setDevPersona } from '@/app/dev/actions'

/** Sets the dev session cookie, then lands on that persona's home screen. */
export function PersonaSwitcher({
  authId,
  href,
  label,
}: {
  authId: string
  href: string
  label: string
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  return (
    <button
      type="button"
      className="btn btn-primary text-sm whitespace-nowrap"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        await setDevPersona(authId)
        router.push(href)
        router.refresh()
      }}
    >
      {label}
    </button>
  )
}
