'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { savePushSubscription } from '@/app/(participant)/actions'

/**
 * One tap to get told when a drop opens. Asks for permission, subscribes the service
 * worker and stores the subscription on the User. Denied or unsupported is fine —
 * the SMS fallback covers it (docs/06 section 7) — so the only visible outcome is
 * the row refreshing to "on" or staying as it was.
 *
 * Renders nothing until mounted (Notification is browser-only) and nothing at all
 * when the browser has no push support or already decided.
 */
export function EnableNotifications({
  label,
  hint,
  className,
}: {
  label: string
  hint: string
  className?: string
}) {
  const router = useRouter()
  const [state, setState] = useState<'unknown' | 'askable' | 'hidden'>('unknown')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const askable =
      typeof Notification !== 'undefined' &&
      'serviceWorker' in navigator &&
      Notification.permission === 'default'
    setState(askable ? 'askable' : 'hidden')
  }, [])

  async function enable() {
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        })
        await savePushSubscription(subscription.toJSON())
        router.refresh()
      }
    } catch {
      // Denied or unsupported — nothing to show.
    }
    setBusy(false)
  }

  if (state !== 'askable') return null

  return (
    <button type="button" onClick={enable} disabled={busy} className={className}>
      <span
        className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-[var(--color-amber)]"
        aria-hidden="true"
      />
      <span className="text-left">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-[var(--color-ink-2)]">{hint}</span>
      </span>
    </button>
  )
}
