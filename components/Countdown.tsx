'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

/**
 * "expires in 11h" — docs/02 Cross-cutting: "every screen showing a timed state shows
 * the deadline in local time and relative".
 *
 * Renders the absolute time on the server pass and switches to relative once mounted,
 * so there is no hydration mismatch and no blank first paint.
 */
export function Countdown({ to, className }: { to: string; className?: string }) {
  const t = useTranslations('common')
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const target = new Date(to)

  if (now === null) {
    return (
      <time dateTime={to} className={className}>
        {target.toLocaleDateString('sv-SE')}
      </time>
    )
  }

  const remaining = target.getTime() - now
  if (remaining <= 0) {
    return (
      <time dateTime={to} className={className}>
        {t('expired')}
      </time>
    )
  }

  const hours = Math.floor(remaining / 3_600_000)
  const label =
    hours >= 48
      ? `${Math.floor(hours / 24)}d`
      : hours >= 1
        ? `${hours}h`
        : `${Math.max(1, Math.floor(remaining / 60_000))}m`

  return (
    <time dateTime={to} title={target.toLocaleString('sv-SE')} className={className}>
      {t('expiresIn', { time: label })}
    </time>
  )
}
