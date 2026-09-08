'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { requestQueueLink } from '@/app/(marketing)/queue/actions'

/** /queue without a cookie: the link is in your inbox, or can be again. */
export function QueueLinkForm() {
  const t = useTranslations('queue.link')
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    const result = await requestQueueLink(email)
    setPending(false)
    if (result.ok) setSent(true)
    else setError(result.error === 'rateLimited' ? t('rateLimited') : t('invalidEmail'))
  }

  return (
    <section className="section">
      <div className="wrap max-w-md">
        <div className="card p-6">
          <span className="nod-marker mb-5 block" aria-hidden="true" />
          <h1 className="text-2xl mb-2">{t('title')}</h1>
          {sent ? (
            <p className="text-sm text-[var(--color-ink-2)]">{t('sent')}</p>
          ) : (
            <form onSubmit={onSubmit} className="grid gap-3">
              <p className="text-sm text-[var(--color-ink-2)]">{t('body')}</p>
              <input
                type="email"
                required
                autoComplete="email"
                className="field"
                aria-label={t('email')}
                placeholder={t('email')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {error && <p className="error-text">{error}</p>}
              <button type="submit" className="btn btn-primary w-full" disabled={pending || !email}>
                {pending ? t('sending') : t('submit')}
              </button>
              <p className="text-xs text-[var(--color-ink-3)]">
                {t('notYet')}{' '}
                <Link href="/#waitlist" className="underline">
                  {t('join')}
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
