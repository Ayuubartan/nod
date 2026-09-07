'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * While a render is in flight the page is a dead end; refresh it every few seconds so
 * the participant lands in review the moment the composite exists. Both engines are
 * quick (local: sub-second; hosted: tens of seconds), and the ops queue path sends a
 * push when it is done, so the poll is only for the happy path.
 */
export function GeneratingPoll({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    const id = setInterval(() => router.refresh(), everyMs)
    return () => clearInterval(id)
  }, [router, everyMs])
  return null
}
