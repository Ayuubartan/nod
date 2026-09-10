'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { requestLoginCode, verifyLoginCode } from '@/app/(auth)/actions'
import type { SignInError, SocialProvider } from '@/lib/social-signin'

type Audience = 'PARTICIPANT' | 'BRAND'

/**
 * Two screens: address, then code. Shared by creators and brand users — the audience
 * decides the copy and what an unknown address means (new creator vs. no such brand).
 *
 * Embedded (`initialEmail` + `embedded`) it is the second half of the waitlist form:
 * the address is already known, the code is requested at once, and only the code
 * screen is shown — joining the waitlist and opening the account are one motion.
 *
 * `providers` is whatever social sign-in is configured (lib/social-signin.ts). It is a
 * prop rather than a hook because the answer lives in a server-only env var, and the
 * list is empty in every environment that has not set one up — so the page below looks
 * exactly as it did before. The buttons are plain links to a route handler: no client
 * SDK, no token ever reaching this component.
 */
export function LoginForm({
  audience,
  next,
  initialEmail = '',
  embedded = false,
  providers = [],
  initialError = null,
}: {
  audience: Audience
  next: string | null
  initialEmail?: string
  embedded?: boolean
  providers?: SocialProvider[]
  initialError?: SignInError | null
}) {
  const t = useTranslations('auth')
  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [devCode, setDevCode] = useState<string | null>(null)
  const [error, setError] = useState<SignInError | null>(initialError)
  const [pending, start] = useTransition()

  const brand = audience === 'BRAND'

  function request() {
    setError(null)
    start(async () => {
      const result = await requestLoginCode({ email, audience })
      if (!result.ok) return setError(result.error)
      setDevCode(result.devCode ?? null)
      setCode('')
      setSent(true)
    })
  }

  function onRequest(e: React.FormEvent) {
    e.preventDefault()
    request()
  }

  // With a known address the code goes out immediately, once.
  const requested = useRef(false)
  useEffect(() => {
    if (initialEmail && !requested.current) {
      requested.current = true
      request()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEmail])

  function onVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    start(async () => {
      // Success redirects from the server; only failures come back.
      const result = await verifyLoginCode({ email, code, audience, next })
      if (result && !result.ok) setError(result.error)
    })
  }

  // Not in the waitlist variant: the address is already known there, and a social
  // button would drop the person out of the queue flow they are halfway through.
  const showSocial = !embedded && !sent && providers.length > 0
  const socialQuery = new URLSearchParams({
    audience,
    ...(next ? { next } : {}),
  }).toString()

  return (
    <div className={embedded ? '' : 'max-w-sm mx-auto'}>
      {!embedded && (
        <>
          <p className="text-xs uppercase tracking-wide text-[var(--color-ink-3)] mb-2">
            {brand ? t('brandKicker') : t('participantKicker')}
          </p>
          <h1 className="text-2xl mb-2">{brand ? t('brandTitle') : t('participantTitle')}</h1>
          <p className="text-sm text-[var(--color-ink-2)] mb-6">
            {brand ? t('brandHint') : t('participantHint')}
          </p>
        </>
      )}

      {showSocial && (
        <div className="flex flex-col gap-3 mb-4">
          {providers.map((provider) => (
            <a
              key={provider}
              className="btn btn-secondary w-full"
              href={`/api/sign-in/${provider}/start?${socialQuery}`}
            >
              {t(`continueWith.${provider}`)}
            </a>
          ))}
          <div className="flex items-center gap-3 text-xs text-[var(--color-ink-3)]">
            <span className="h-px flex-1 bg-[var(--color-line)]" />
            {t('orEmail')}
            <span className="h-px flex-1 bg-[var(--color-line)]" />
          </div>
        </div>
      )}

      {!sent ? (
        <form onSubmit={onRequest} className="card p-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="label">{t('emailLabel')}</span>
            <input
              className="field"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={brand ? 'namn@foretag.se' : 'namn@exempel.se'}
            />
          </label>
          {error && (
            <p className="text-sm text-[var(--color-red)]">
              {t(`errors.${error}`)}
              {error === 'waitlistOnly' && (
                <>
                  {' '}
                  <Link href="/queue" className="underline">
                    {t('toQueue')}
                  </Link>
                </>
              )}
            </p>
          )}
          <button className="btn btn-primary w-full" type="submit" disabled={pending || !email}>
            {pending ? t('sending') : t('sendCode')}
          </button>
        </form>
      ) : (
        <form onSubmit={onVerify} className="card p-5 flex flex-col gap-4">
          <p className="text-sm text-[var(--color-ink-2)]">{t('codeSent', { email })}</p>
          <label className="flex flex-col gap-1">
            <span className="label">{t('codeLabel')}</span>
            <input
              className="field text-2xl tracking-[0.4em] text-center font-[family-name:var(--font-mono)]"
              type="text"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          {devCode && (
            <p className="text-xs rounded-lg bg-[#fbe3b5] text-[var(--color-ink)] px-3 py-2">
              {t('devCode', { code: devCode })}
            </p>
          )}
          {error && (
            <p className="text-sm text-[var(--color-red)]">
              {t(`errors.${error}`)}
              {error === 'waitlistOnly' && (
                <>
                  {' '}
                  <Link href="/queue" className="underline">
                    {t('toQueue')}
                  </Link>
                </>
              )}
            </p>
          )}
          <button
            className="btn btn-primary w-full"
            type="submit"
            disabled={pending || code.length !== 6}
          >
            {pending ? t('checking') : t('verify')}
          </button>
          <div className="flex justify-between text-xs text-[var(--color-ink-2)]">
            <button
              type="button"
              className="underline"
              onClick={() => setSent(false)}
              disabled={pending}
            >
              {t('changeEmail')}
            </button>
            <button type="button" className="underline" onClick={onRequest} disabled={pending}>
              {t('resend')}
            </button>
          </div>
        </form>
      )}

      {!embedded && (
        <p className="text-sm text-[var(--color-ink-2)] mt-6 text-center">
          {brand ? (
            <Link href="/sign-in" className="underline">
              {t('switchToParticipant')}
            </Link>
          ) : (
            <Link href="/brand/sign-in" className="underline">
              {t('switchToBrand')}
            </Link>
          )}
        </p>
      )}
    </div>
  )
}
