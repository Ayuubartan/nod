'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { joinWaitlist } from '@/app/(marketing)/actions'
import { EVENTS, track } from '@/lib/analytics'

const CITIES = ['stockholm', 'goteborg', 'malmo', 'uppsala', 'other'] as const

/**
 * Page one of the waitlist game (docs/13): the least we can ask — city, mobile,
 * email, one tick — and then straight to /queue, where the rank, the level and the
 * invite link are waiting. Everything else (handle, age, followers, interests) is
 * asked there, for points, once the person has something to lose.
 */
export function WaitlistForm() {
  const t = useTranslations('marketing.waitlist')
  const router = useRouter()

  const [ref, setRef] = useState('')
  const [utm, setUtm] = useState<{ source: string; medium: string; campaign: string }>({ source: '', medium: '', campaign: '' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [already, setAlready] = useState(false)

  // Referral code arrives as ?ref=CODE on a shared link (or from the /r/CODE cookie,
  // which the server reads itself). UTM tags ride along for attribution.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('ref')
    if (code) setRef(code.toUpperCase())
    setUtm({
      source: params.get('utm_source') ?? '',
      medium: params.get('utm_medium') ?? '',
      campaign: params.get('utm_campaign') ?? '',
    })
    track(EVENTS.waitlistViewed, {})
  }, [])

  // Where feedback appears — scrolled into view on phones, where the button sits below
  // the fold and a message above it would otherwise go unseen.
  const feedback = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error || already) feedback.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [error, already])

  async function onSubmit(formData: FormData) {
    setError(null)
    setAlready(false)
    // Checked here rather than with `required`: the browser's bubble is gone in a
    // second on iOS and reads as "nothing happened". The server checks it again.
    if (formData.get('consent') !== 'on') {
      setError('consent')
      return
    }
    setPending(true)

    const result = await joinWaitlist({
      city: formData.get('city'),
      phone: formData.get('phone'),
      email: formData.get('email'),
      referredBy: ref || null,
      consent: formData.get('consent') === 'on',
      smsConsent: formData.get('smsConsent') === 'on',
      source: 'web',
      utmSource: utm.source || null,
      utmMedium: utm.medium || null,
      utmCampaign: utm.campaign || null,
    })

    if (result.ok) {
      track(EVENTS.waitlistSubmitted, {
        position: result.position,
        city: formData.get('city'),
        referred: Boolean(ref),
        sms: formData.get('smsConsent') === 'on',
      })
      // ?joined=1 asks /queue for the one-time welcome; it strips it again on mount.
      router.push('/queue?joined=1')
      return
    }
    setPending(false)
    if (result.error === 'duplicate') setAlready(true)
    else setError(result.error)
  }

  return (
    <section className="section" id="waitlist">
      <div className="wrap max-w-xl">
        <h2 className="text-2xl sm:text-3xl mb-1">{t('title')}</h2>
        <p className="text-[var(--color-ink-2)] mb-6">{t('sub')}</p>

        <form action={onSubmit} className="card p-5 sm:p-6 grid gap-4">
          <div>
            <label className="label" htmlFor="city">
              {t('city')}
            </label>
            <select id="city" name="city" required defaultValue="stockholm" className="field">
              {CITIES.map((c) => (
                <option key={c} value={c}>
                  {t(`cityOptions.${c}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="phone">
              {t('phone')}
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="070-123 45 67"
              className="field"
            />
            <p className="text-xs text-[var(--color-ink-3)] mt-1">{t('phoneHint')}</p>
          </div>

          <div>
            <label className="label" htmlFor="email">
              {t('email')}
            </label>
            <input id="email" name="email" type="email" required autoComplete="email" className="field" />
          </div>

          {ref && (
            <p className="text-xs text-[var(--color-ink-2)]">
              {t('referralCode')}: <span className="tabular font-semibold">{ref}</span>
            </p>
          )}

          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" name="consent" className="mt-1" />
            <span>
              {t('consent')}{' '}
              <Link href="/privacy" className="underline" target="_blank">
                {t('consentPrivacyLink')}
              </Link>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" name="smsConsent" className="mt-1" />
            <span>
              {t('smsConsent')} <span className="text-[var(--color-ink-3)]">{t('smsConsentHint')}</span>
            </span>
          </label>

          <div ref={feedback}>
            {already && (
              <div className="card p-4 border-[var(--color-teal)]" role="status" aria-live="polite">
                <p className="font-semibold mb-1">{t('alreadyTitle')}</p>
                <p className="text-sm text-[var(--color-ink-2)]">
                  {t('already')}{' '}
                  <Link href="/queue" className="underline">
                    {t('alreadyLink')}
                  </Link>
                </p>
              </div>
            )}
            {error && (
              <p className="error-text" role="alert">
                {t(`errors.${error}`)}
              </p>
            )}
          </div>

          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending ? t('submitting') : t('submit')}
          </button>
        </form>
      </div>
    </section>
  )
}
