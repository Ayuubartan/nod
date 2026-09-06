'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { submitBrandEnquiry } from '@/app/(marketing)/actions'
import { EVENTS, track } from '@/lib/analytics'

const BUDGETS = ['10-25k', '25-100k', '100k+'] as const

export function BrandEnquiryForm() {
  const t = useTranslations('brands.enquiry')
  const errors = useTranslations('marketing.waitlist.errors')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(formData: FormData) {
    setPending(true)
    setError(null)

    const result = await submitBrandEnquiry({
      company: formData.get('company'),
      name: formData.get('name'),
      email: formData.get('email'),
      budgetBracket: formData.get('budgetBracket'),
      objective: formData.get('objective') || null,
      message: formData.get('message') || null,
    })

    setPending(false)
    if (result.ok) {
      setDone(true)
      track(EVENTS.brandEnquirySubmitted, { budget_bracket: formData.get('budgetBracket') })
    } else {
      setError(result.error)
    }
  }

  if (done) {
    return (
      <section className="section" id="enquiry">
        <div className="wrap max-w-xl">
          <div className="card p-6 text-center">
            <h2 className="text-2xl mb-2">{t('success')}</h2>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="section" id="enquiry">
      <div className="wrap max-w-xl">
        <h2 className="text-2xl sm:text-3xl mb-6">{t('title')}</h2>
        <form action={onSubmit} className="card p-5 sm:p-6 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="company">
                {t('company')}
              </label>
              <input id="company" name="company" required className="field" autoComplete="organization" />
            </div>
            <div>
              <label className="label" htmlFor="name">
                {t('name')}
              </label>
              <input id="name" name="name" required className="field" autoComplete="name" />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="brand-email">
              {t('email')}
            </label>
            <input id="brand-email" name="email" type="email" required className="field" autoComplete="email" />
          </div>

          <div>
            <label className="label" htmlFor="budgetBracket">
              {t('budgetBracket')}
            </label>
            <select id="budgetBracket" name="budgetBracket" required defaultValue="" className="field">
              <option value="" disabled>
                —
              </option>
              {BUDGETS.map((b) => (
                <option key={b} value={b}>
                  {t(`budgetOptions.${b}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="objective">
              {t('objective')}
            </label>
            <input id="objective" name="objective" className="field" />
          </div>

          <div>
            <label className="label" htmlFor="message">
              {t('message')}
            </label>
            <textarea id="message" name="message" rows={4} className="field" />
          </div>

          {error && (
            <p className="error-text" role="alert">
              {error === 'rateLimited' ? errors('rateLimited') : errors('email')}
            </p>
          )}

          <button
            type="submit"
            className="btn text-white w-full"
            style={{ background: 'var(--color-blue)' }}
            disabled={pending}
          >
            {t('submit')}
          </button>
        </form>
      </div>
    </section>
  )
}
