'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  completeOnboarding,
  connectAccount,
  createParticipant,
  savePushSubscription,
} from '@/app/(participant)/actions'
import { EVENTS, track } from '@/lib/analytics'
import { estimateParticipantOre, formatKrDown } from '@/lib/money/calc'
import { ESTIMATOR_RANGE } from '@/lib/money/rates'

type ExistingAccount = {
  id: string
  handle: string
  tier: string
  followers: number
  avgViews30d: number
  accountType: string | null
}

type Existing = {
  id: string
  city: string | null
  ageBracket: string | null
  accounts: ExistingAccount[]
  referralCode: string
} | null

const CITIES = ['stockholm', 'goteborg', 'malmo', 'uppsala', 'other'] as const
/** No under-18 option exists anywhere in NOD (docs/07 section 6). */
const AGE_BRACKETS = ['18-20', '21-25', '26-30', '31+'] as const

const TOTAL_STEPS = 9

/**
 * The nine onboarding screens from docs/02 A1, as one client flow so the whole thing is
 * a single page load on a phone. Each step fires a PostHog event so the drop-off funnel
 * in the M1 acceptance criteria is measurable per screen.
 */
export function OnboardingFlow({
  authId,
  email,
  existing,
  nextDrop,
}: {
  authId: string
  /** The address the sign-in code was sent to; stored on the User for next time. */
  email: string | null
  existing: Existing
  nextDrop: string
}) {
  const t = useTranslations('onboarding')
  const common = useTranslations('common')
  const router = useRouter()

  const [step, setStep] = useState(existing ? (existing.accounts.length > 0 ? 4 : 2) : 1)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // step 1
  const [city, setCity] = useState(existing?.city ?? 'stockholm')
  const [ageBracket, setAgeBracket] = useState(existing?.ageBracket ?? '')
  // step 2
  const [handle, setHandle] = useState('')
  const [accounts, setAccounts] = useState<ExistingAccount[]>(existing?.accounts ?? [])
  // step 5-7
  const [quizAnswer, setQuizAnswer] = useState<string | null>(null)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [trainingConsent, setTrainingConsent] = useState(false)
  const [swishNumber, setSwishNumber] = useState('')

  const account = accounts[0] ?? null

  const go = (next: number) => {
    track(EVENTS.onboardingStepCompleted, { step })
    track(EVENTS.onboardingStepViewed, { step: next })
    setStep(next)
    setError(null)
  }

  async function onSignUp() {
    setPending(true)
    setError(null)
    const result = await createParticipant({
      authId,
      email,
      city,
      ageBracket,
      locale: 'sv',
      referredByCode: new URLSearchParams(window.location.search).get('ref'),
    })
    setPending(false)
    if (result.ok) go(2)
    else setError(result.error)
  }

  async function onConnect() {
    setPending(true)
    setError(null)
    const result = await connectAccount(handle.replace(/^@/, '') || 'testuser')
    setPending(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    router.refresh()
    setAccounts([
      {
        id: 'pending',
        handle: handle.replace(/^@/, '') || 'testuser',
        tier: result.data?.tier ?? 'CONNECTED_SCREENSHOT',
        followers: 0,
        avgViews30d: 0,
        accountType: result.data?.tier === 'CONNECTED_API' ? 'creator' : 'personal',
      },
    ])
    // A personal account gets the Creator-switch screen; a creator account skips it.
    go(result.data?.tier === 'CONNECTED_API' ? 4 : 3)
  }

  async function onFinish() {
    setPending(true)
    setError(null)
    const result = await completeOnboarding({
      termsAccepted: termsAccepted as true,
      disclosureQuizPassed: (quizAnswer === 'a') as true,
      trainingConsent,
      swishNumber,
    })
    setPending(false)

    if (result.ok) {
      track(EVENTS.onboardingCompleted, {})
      go(9)
    } else {
      setError(result.error)
    }
  }

  async function onEnableNotifications() {
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'granted' && 'serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        })
        await savePushSubscription(subscription.toJSON())
      }
    } catch {
      // Denied or unsupported — the SMS fallback covers it (docs/06 section 7).
    }
    go(9)
  }

  const estimate = account
    ? formatKrDown(estimateParticipantOre(ESTIMATOR_RANGE.high, account.avgViews30d || 450))
    : null

  return (
    <div className="max-w-md mx-auto">
      <p className="text-xs text-[var(--color-ink-3)] mb-4 tabular">
        {t('stepOf', { step, total: TOTAL_STEPS })}
      </p>

      {step === 1 && (
        <section className="card p-5 grid gap-4">
          <div>
            <h1 className="text-xl mb-1">{t('signup.title')}</h1>
            <p className="text-sm text-[var(--color-ink-2)]">{t('signup.sub')}</p>
          </div>

          <div>
            <label className="label" htmlFor="ob-city">
              {t('signup.city')}
            </label>
            <select id="ob-city" className="field" value={city} onChange={(e) => setCity(e.target.value)}>
              {CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="ob-age">
              {t('signup.ageBracket')}
            </label>
            <select
              id="ob-age"
              className="field"
              value={ageBracket}
              onChange={(e) => setAgeBracket(e.target.value)}
            >
              <option value="" disabled>
                —
              </option>
              {AGE_BRACKETS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <p className="text-xs text-[var(--color-ink-3)] mt-1">{t('signup.under18')}</p>
          </div>

          {error && <p className="error-text">{error}</p>}

          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={pending || !ageBracket}
            onClick={onSignUp}
          >
            {common('next')}
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="card p-5 grid gap-4">
          <div>
            <h1 className="text-xl mb-1">{t('connect.title')}</h1>
            <p className="text-sm text-[var(--color-ink-2)]">{t('connect.sub')}</p>
          </div>

          <div className="grid gap-3 text-sm">
            <div>
              <p className="label">{t('connect.weRead')}</p>
              <p className="text-[var(--color-ink-2)]">{t('connect.weReadItems')}</p>
            </div>
            <div>
              <p className="label">{t('connect.weNever')}</p>
              <p className="text-[var(--color-ink-2)]">{t('connect.weNeverItems')}</p>
            </div>
          </div>

          <input
            className="field"
            placeholder="@handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />

          {error && <p className="error-text">{error}</p>}

          <button type="button" className="btn btn-primary w-full" disabled={pending} onClick={onConnect}>
            {t('connect.connect')}
          </button>
        </section>
      )}

      {step === 3 && (
        <section className="card p-5 grid gap-4">
          <div>
            <h1 className="text-xl mb-1">{t('creator.title')}</h1>
            <p className="text-sm text-[var(--color-ink-2)]">{t('creator.sub')}</p>
          </div>
          <p className="card px-3 py-2 text-sm bg-[var(--color-bg)]">{t('creator.steps')}</p>
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={() => {
              track(EVENTS.creatorSwitchAccepted, {})
              void onConnect()
            }}
          >
            {t('creator.done')}
          </button>
          <button
            type="button"
            className="btn btn-secondary w-full"
            onClick={() => {
              track(EVENTS.creatorSwitchSkipped, {})
              go(4)
            }}
          >
            {t('creator.skip')}
          </button>
        </section>
      )}

      {step === 4 && (
        <section className="card p-5 grid gap-4">
          <h1 className="text-xl">{t('profile.title')}</h1>

          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--color-ink-2)]">{t('profile.followers')}</dt>
              <dd className="amount font-semibold">{(account?.followers ?? 0).toLocaleString('sv-SE')}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--color-ink-2)]">{t('profile.avgViews')}</dt>
              <dd className="amount font-semibold">{(account?.avgViews30d ?? 0).toLocaleString('sv-SE')}</dd>
            </div>
          </dl>

          {estimate && (
            <p className="text-lg font-semibold">{t('profile.estimate', { amount: estimate })}</p>
          )}

          {account?.tier === 'BELOW_FLOOR' && (
            <p className="text-sm text-[var(--color-ink-2)]">{t('profile.belowFloor')}</p>
          )}

          <button type="button" className="btn btn-primary w-full" onClick={() => go(5)}>
            {common('next')}
          </button>
        </section>
      )}

      {step === 5 && (
        <section className="card p-5 grid gap-4">
          <h1 className="text-xl">{t('terms.title')}</h1>

          <label className="flex gap-3 items-start text-sm">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-1 size-4 accent-[var(--color-amber)]"
            />
            <span>{t('terms.accept')}</span>
          </label>

          <div>
            <p className="label">{t('terms.quizTitle')}</p>
            <p className="text-sm mb-3">{t('terms.quizQuestion')}</p>
            <div className="grid gap-2">
              {(['a', 'b', 'c'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className="chip text-left"
                  aria-pressed={quizAnswer === option}
                  onClick={() => setQuizAnswer(option)}
                >
                  {t(`terms.quizOption${option.toUpperCase()}` as never, { brand: 'Kaffeklubben' })}
                </button>
              ))}
            </div>
            {quizAnswer && (
              <p className={`text-sm mt-2 ${quizAnswer === 'a' ? 'text-[var(--color-green)]' : 'text-[var(--color-red)]'}`}>
                {quizAnswer === 'a' ? t('terms.quizRight') : t('terms.quizWrong')}
              </p>
            )}
          </div>

          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={!termsAccepted || quizAnswer !== 'a'}
            onClick={() => go(6)}
          >
            {common('next')}
          </button>
        </section>
      )}

      {step === 6 && (
        <section className="card p-5 grid gap-4">
          <h1 className="text-xl">{t('training.title')}</h1>

          {/* Separate, unbundled, default off, revocable (docs/07 section 2). */}
          <label className="flex gap-3 items-start text-sm">
            <input
              type="checkbox"
              checked={trainingConsent}
              onChange={(e) => setTrainingConsent(e.target.checked)}
              className="mt-1 size-4 accent-[var(--color-amber)]"
            />
            <span>{t('training.consent')}</span>
          </label>

          <p className="text-xs text-[var(--color-ink-3)]">{t('training.note')}</p>

          <button type="button" className="btn btn-primary w-full" onClick={() => go(7)}>
            {common('next')}
          </button>
        </section>
      )}

      {step === 7 && (
        <section className="card p-5 grid gap-4">
          <h1 className="text-xl">{t('payout.title')}</h1>

          <div>
            <label className="label" htmlFor="ob-swish">
              {t('payout.swish')}
            </label>
            <input
              id="ob-swish"
              className="field"
              inputMode="tel"
              placeholder="070-123 45 67"
              value={swishNumber}
              onChange={(e) => setSwishNumber(e.target.value)}
            />
            <p className="text-xs text-[var(--color-ink-3)] mt-1">{t('payout.swishHint')}</p>
          </div>

          {error && <p className="error-text">{error === 'invalidSwish' ? t('payout.invalid') : error}</p>}

          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={pending || swishNumber.length < 6}
            onClick={onFinish}
          >
            {common('next')}
          </button>
        </section>
      )}

      {step === 8 && (
        <section className="card p-5 grid gap-4">
          <div>
            <h1 className="text-xl mb-1">{t('notifications.title')}</h1>
            <p className="text-sm text-[var(--color-ink-2)]">{t('notifications.sub')}</p>
          </div>
          <button type="button" className="btn btn-primary w-full" onClick={onEnableNotifications}>
            {t('notifications.enable')}
          </button>
          <button type="button" className="btn btn-secondary w-full" onClick={() => go(9)}>
            {t('notifications.skip')}
          </button>
        </section>
      )}

      {step === 9 && (
        <section className="card p-5 text-center grid gap-4">
          <span className="nod-marker mx-auto" aria-hidden="true" />
          <h1 className="text-2xl">{t('done.title')}</h1>
          <p className="text-sm text-[var(--color-ink-2)]">
            {t('done.sub', {
              date: new Date(nextDrop).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }),
            })}
          </p>
          <button type="button" className="btn btn-primary w-full" onClick={() => router.push('/campaigns')}>
            {t('done.browse')}
          </button>
          <button type="button" className="btn btn-secondary w-full" onClick={() => router.push('/invite')}>
            {t('done.invite')}
          </button>
        </section>
      )}
    </div>
  )
}
