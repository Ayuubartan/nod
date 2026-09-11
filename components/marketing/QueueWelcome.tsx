'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { EVENTS, track } from '@/lib/analytics'

/**
 * The moment after joining — shown once, on the arrival from the waitlist form
 * (`/queue?joined=1`), above the normal queue page.
 *
 * Three things and no more: thanks, the number, and the single action that moves it
 * (copy the invite link). The number counts up because a position that just appears
 * reads as a fact; one that arrives reads as an event. `?joined=1` is stripped from
 * the address bar on mount so a refresh — or a shared screenshot's URL — shows the
 * ordinary page; the welcome is for the person who just did the thing.
 */
export function QueueWelcome({
  position,
  email,
  emailVerified,
  shareUrl,
}: {
  position: number
  email: string
  emailVerified: boolean
  shareUrl: string
}) {
  const t = useTranslations('queue.welcome')
  const [shown, setShown] = useState(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    window.history.replaceState(null, '', '/queue')

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || position < 2) {
      setShown(position)
      return
    }
    const start = performance.now()
    const duration = 900
    let frame = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      // Ease-out: fast at first, settling on the real number.
      setShown(Math.round(position * (1 - Math.pow(1 - p, 3))))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [position])

  function copy() {
    void navigator.clipboard.writeText(shareUrl)
    setCopied(true)
    track(EVENTS.referralLinkCopied, { channel: 'welcome' })
  }

  const colours = ['#20C5C7', '#FF7417', '#111820', '#20C5C7', '#FF7417']

  return (
    <div className="card p-6 text-center relative overflow-hidden welcome-pop" role="status" aria-live="polite">
      {Array.from({ length: 14 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="confetti"
          style={{
            left: `${4 + ((i * 37) % 92)}%`,
            background: colours[i % colours.length],
            animationDelay: `${(i % 7) * 90}ms`,
          }}
        />
      ))}
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-teal)] mb-3">{t('kicker')}</p>
      <p className="text-2xl font-bold">{t('title', { position: shown.toLocaleString('sv-SE') })}</p>
      <p className="text-sm text-[var(--color-ink-2)] mt-3">
        {emailVerified ? t('mailedVerified') : t('mailed', { email })}
      </p>
      <button type="button" className="btn btn-primary mt-5" onClick={copy}>
        {copied ? t('copied') : t('cta')}
      </button>
    </div>
  )
}
