'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { requestLoginCode, verifyLoginCode } from '@/app/(auth)/actions'
import type { LoginError } from '@/lib/login'

type Audience = 'PARTICIPANT' | 'BRAND'

/**
 * Two screens: address, then code. Shared by creators and brand users — the audience
 * decides the copy and what an unknown address means (new creator vs. no such brand).
 */
export function LoginForm({ audience, next }: { audience: Audience; next: string | null }) {
  const t = useTranslations('auth')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [devCode, setDevCode] = useState<string | null>(null)
  const [error, setError] = useState<LoginError | null>(null)
  const [pending, start] = useTransition()

  const brand = audience === 'BRAND'

  function onRequest(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    start(async () => {
      const result = await requestLoginCode({ email, audience })
      if (!result.ok) return setError(result.error)
      setDevCode(result.devCode ?? null)
      setCode('')
      setSent(true)
    })
  }

  function onVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    start(async () => {
      // Success redirects from the server; only failures come back.
      const result = await verifyLoginCode({ email, code, audience, next })
      if (result && !result.ok) setError(result.error)
    })
  }

  return (
    <div className="max-w-sm mx-auto">
      <p className="text-xs uppercase tracking-wide text-[var(--color-ink-3)] mb-2">
        {brand ? t('brandKicker') : t('participantKicker')}
      </p>
      <h1 className="text-2xl mb-2">{brand ? t('brandTitle') : t('participantTitle')}</h1>
      <p className="text-sm text-[var(--color-ink-2)] mb-6">{brand ? t('brandHint') : t('participantHint')}</p>

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
          {error && <p className="text-sm text-[var(--color-red)]">{t(`errors.${error}`)}</p>}
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
          {error && <p className="text-sm text-[var(--color-red)]">{t(`errors.${error}`)}</p>}
          <button className="btn btn-primary w-full" type="submit" disabled={pending || code.length !== 6}>
            {pending ? t('checking') : t('verify')}
          </button>
          <div className="flex justify-between text-xs text-[var(--color-ink-2)]">
            <button type="button" className="underline" onClick={() => setSent(false)} disabled={pending}>
              {t('changeEmail')}
            </button>
            <button type="button" className="underline" onClick={onRequest} disabled={pending}>
              {t('resend')}
            </button>
          </div>
        </form>
      )}

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
    </div>
  )
}
