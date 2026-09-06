import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Estimator } from '@/components/marketing/Estimator'
import { WaitlistForm } from '@/components/marketing/WaitlistForm'
import { PhoneMock } from '@/components/marketing/PhoneMock'
import { Faq } from '@/components/marketing/Faq'

/**
 * Landing page — docs/01.
 *
 * Server-rendered per request rather than statically cached: the language comes from a
 * cookie (docs/01 "default from Accept-Language, persisted in cookie"), and a static
 * page cannot vary by cookie — it would serve Swedish to an English reader. The page
 * reads no database and does no auth, so it is still a sub-100ms render, and everything
 * interactive is a small client island.
 */
export const dynamic = 'force-dynamic'

export default async function LandingPage() {
  const t = await getTranslations('marketing')

  const steps = [
    { title: t('how.step1Title'), body: t('how.step1Body') },
    { title: t('how.step2Title'), body: t('how.step2Body') },
    { title: t('how.step3Title'), body: t('how.step3Body') },
  ]

  const trust = [
    { title: t('trust.card1Title'), body: t('trust.card1Body') },
    { title: t('trust.card2Title'), body: t('trust.card2Body') },
    { title: t('trust.card3Title'), body: t('trust.card3Body') },
  ]

  const chipKeys = ['gym', 'food', 'study', 'travel', 'fashion', 'gaming', 'nightlife', 'hobby'] as const

  return (
    <>
      {/* 1. Hero */}
      <section className="section pt-10">
        <div className="wrap grid gap-10 md:grid-cols-2 md:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-amber-dk)] mb-4">
              {t('eyebrow')}
            </p>
            <h1 className="text-4xl sm:text-5xl leading-[1.05] mb-5">{t('hero.title')}</h1>
            <p className="text-lg text-[var(--color-ink-2)] mb-8 max-w-prose">{t('hero.sub')}</p>
            <div className="flex flex-wrap gap-3">
              <a href="#waitlist" className="btn btn-primary">
                {t('hero.ctaPrimary')}
              </a>
              <Link href="/brands" className="btn btn-secondary">
                {t('hero.ctaSecondary')}
              </Link>
            </div>
          </div>
          <PhoneMock caption={t('hero.phoneCaption')} />
        </div>
      </section>

      {/* 2. How it works */}
      <section className="section border-t border-[var(--color-line)]">
        <div className="wrap">
          <h2 className="text-2xl sm:text-3xl mb-8">{t('how.title')}</h2>
          <ol className="grid gap-4 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title} className="card p-5">
                <span className="amount text-sm text-[var(--color-amber-dk)] font-semibold">0{index + 1}</span>
                <h3 className="text-lg mt-2 mb-1">{step.title}</h3>
                <p className="text-sm text-[var(--color-ink-2)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 3. Estimator */}
      <div className="border-t border-[var(--color-line)]">
        <Estimator />
      </div>

      {/* 4. Trust */}
      <section className="section border-t border-[var(--color-line)]">
        <div className="wrap">
          <h2 className="text-2xl sm:text-3xl mb-8">{t('trust.title')}</h2>
          <ul className="grid gap-4 sm:grid-cols-3">
            {trust.map((card) => (
              <li key={card.title} className="card p-5">
                <span className="nod-marker mb-4 block" aria-hidden="true" />
                <h3 className="text-lg mb-1">{card.title}</h3>
                <p className="text-sm text-[var(--color-ink-2)]">{card.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 5. Who it's for */}
      <section className="section border-t border-[var(--color-line)]">
        <div className="wrap">
          <h2 className="text-2xl sm:text-3xl mb-2">{t('who.title')}</h2>
          <p className="text-lg text-[var(--color-ink-2)] mb-6">{t('who.line')}</p>
          <ul className="flex flex-wrap gap-2">
            {chipKeys.map((key) => (
              <li key={key} className="chip">
                {t(`who.chips.${key}`)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 6. FAQ */}
      <div className="border-t border-[var(--color-line)]">
        <Faq />
      </div>

      {/* 7. Waitlist */}
      <div className="border-t border-[var(--color-line)] bg-[var(--color-surface)]">
        <WaitlistForm />
      </div>
    </>
  )
}
