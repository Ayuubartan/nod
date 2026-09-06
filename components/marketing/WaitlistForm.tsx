'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { joinWaitlist, type WaitlistResult } from '@/app/(marketing)/actions'
import { EVENTS, track } from '@/lib/analytics'

const CITIES = ['stockholm', 'goteborg', 'malmo', 'uppsala', 'other'] as const
/** No under-18 option exists anywhere in this list, by design (docs/07 section 6). */
const AGE_BRACKETS = ['18-20', '21-25', '26-30', '31+'] as const
const FOLLOWER_BRACKETS = ['lt300', '300-1k', '1k-5k', '5k-20k', '20k+'] as const
const CATEGORIES = ['gym', 'food', 'study', 'travel', 'fashion', 'gaming', 'nightlife', 'hobby'] as const

export function WaitlistForm() {
  const t = useTranslations('marketing.waitlist')
  const chips = useTranslations('marketing.who.chips')
  const common = useTranslations('common')

  const [categories, setCategories] = useState<string[]>([])
  const [ref, setRef] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<Extract<WaitlistResult, { ok: true }> | null>(null)
  const [copied, setCopied] = useState(false)

  // Referral code arrives as ?ref=CODE on a shared link (docs/01 section 7).
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('ref')
    if (code) setRef(code.toUpperCase())
    track(EVENTS.waitlistViewed, {})
  }, [])

  const toggleCategory = (value: string) =>
    setCategories((current) =>
      current.includes(value) ? current.filter((c) => c !== value) : [...current, value],
    )

  async function onSubmit(formData: FormData) {
    setPending(true)
    setError(null)

    const result = await joinWaitlist({
      handle: formData.get('handle'),
      city: formData.get('city'),
      ageBracket: formData.get('ageBracket'),
      followersBracket: formData.get('followersBracket'),
      categories,
      email: formData.get('email'),
      referredBy: (formData.get('referredBy') as string) || null,
      consent: formData.get('consent') === 'on',
    })

    setPending(false)
    if (result.ok) {
      setSuccess(result)
      track(EVENTS.waitlistSubmitted, {
        position: result.position,
        city: formData.get('city'),
        age_bracket: formData.get('ageBracket'),
        followers_bracket: formData.get('followersBracket'),
        referred: Boolean(formData.get('referredBy')),
      })
    } else {
      setError(result.error)
    }
  }

  if (success) {
    return (
      <section className="section" id="waitlist">
        <div className="wrap max-w-xl">
          <div className="card p-6 text-center">
            <span className="nod-marker mx-auto mb-5 block" aria-hidden="true" />
            <h2 className="text-2xl mb-2">{t('successTitle')}</h2>
            <p className="text-[var(--color-ink-2)] mb-6">{t('successBody', { position: success.position })}</p>
            <p className="text-sm text-[var(--color-ink-2)] mb-3">{t('successReferral')}</p>
            <code className="block text-sm tabular bg-[var(--color-bg)] border border-[var(--color-line)] rounded-lg px-3 py-2 mb-4 break-all">
              {success.shareUrl}
            </code>
            <div className="flex flex-col sm:flex-row gap-2 justify-center">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  void navigator.clipboard.writeText(success.shareUrl)
                  setCopied(true)
                  track(EVENTS.referralLinkCopied, {})
                }}
              >
                {copied ? common('copied') : t('copyLink')}
              </button>
              <a className="btn btn-secondary" href={`/api/og/invite/${success.referralCode}`} download>
                {t('shareStory')}
              </a>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="section" id="waitlist">
      <div className="wrap max-w-xl">
        <h2 className="text-2xl sm:text-3xl mb-1">{t('title')}</h2>
        <p className="text-[var(--color-ink-2)] mb-6">{t('sub')}</p>

        <form action={onSubmit} className="card p-5 sm:p-6 grid gap-4">
          <div>
            <label className="label" htmlFor="handle">
              {t('handle')}
            </label>
            <input
              id="handle"
              name="handle"
              required
              autoComplete="username"
              placeholder={t('handlePlaceholder')}
              className="field"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
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
              <label className="label" htmlFor="ageBracket">
                {t('ageBracket')}
              </label>
              <select id="ageBracket" name="ageBracket" required defaultValue="" className="field">
                <option value="" disabled>
                  —
                </option>
                {AGE_BRACKETS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="followersBracket">
              {t('followersBracket')}
            </label>
            <select id="followersBracket" name="followersBracket" required defaultValue="" className="field">
              <option value="" disabled>
                —
              </option>
              {FOLLOWER_BRACKETS.map((f) => (
                <option key={f} value={f}>
                  {t(`followersOptions.${f}`)}
                </option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend className="label">{t('categories')}</legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip"
                  aria-pressed={categories.includes(c)}
                  onClick={() => toggleCategory(c)}
                >
                  {chips(c)}
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <label className="label" htmlFor="email">
              {t('email')}
            </label>
            <input id="email" name="email" type="email" required autoComplete="email" className="field" />
          </div>

          <div>
            <label className="label" htmlFor="referredBy">
              {t('referralCode')} <span className="font-normal">({common('optional')})</span>
            </label>
            <input
              id="referredBy"
              name="referredBy"
              value={ref}
              onChange={(e) => setRef(e.target.value.toUpperCase())}
              className="field tabular"
            />
          </div>

          <label className="flex gap-3 items-start text-sm text-[var(--color-ink-2)]">
            <input type="checkbox" name="consent" required className="mt-1 size-4 accent-[var(--color-amber)]" />
            <span>
              {t('consent')}{' '}
              <a href="/privacy" className="underline">
                {t('consentPrivacyLink')}
              </a>
            </span>
          </label>

          {error && (
            <p className="error-text" role="alert">
              {t(`errors.${error}` as never, {})}
            </p>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={pending}>
            {pending ? t('submitting') : t('submit')}
          </button>
        </form>
      </div>
    </section>
  )
}
