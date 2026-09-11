import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { Estimator } from '@/components/marketing/Estimator'
import { WaitlistForm } from '@/components/marketing/WaitlistForm'
import { PhoneMock } from '@/components/marketing/PhoneMock'
import { Faq } from '@/components/marketing/Faq'
import { StepIcon } from '@/components/marketing/StepIcon'
import { compact, landingStats } from '@/lib/landing-stats'
import { log } from '@/lib/logger'
import { flag } from '@/lib/flags'

/**
 * Landing page — docs/01, in the Boogaa clothes of docs/10.
 *
 * Server-rendered per request rather than statically cached: the language comes from a
 * cookie (docs/01 "default from Accept-Language, persisted in cookie"), and a static
 * page cannot vary by cookie — it would serve Swedish to an English reader. The stats
 * row reads three counts; everything interactive is a small client island.
 */
export const dynamic = 'force-dynamic'

export default async function LandingPage() {
  const t = await getTranslations('marketing')
  const showSignIn = await flag('marketing.showSignIn')
  const locale = (await getLocale()) === 'sv' ? 'sv' : 'en'

  // DECISION: a database hiccup hides the stats row rather than failing the page.
  const stats = await landingStats().catch((error) => {
    log.warn('landing stats unavailable', { error: String(error) })
    return null
  })
  const statItems = stats
    ? [
        { count: stats.waiting, text: t('stats.waiting', { count: stats.waiting }) },
        { count: stats.posting, text: t('stats.posting', { count: stats.posting }) },
        { count: stats.reach, text: t('stats.reach', { count: compact(stats.reach, locale) }) },
      ].filter((item) => item.count > 0)
    : []

  const steps = [
    { icon: 'play', title: t('how.step1Title'), body: t('how.step1Body') },
    { icon: 'phone', title: t('how.step2Title'), body: t('how.step2Body') },
    { icon: 'wallet', title: t('how.step3Title'), body: t('how.step3Body') },
  ] as const

  const trust = [
    { title: t('trust.card1Title'), body: t('trust.card1Body') },
    { title: t('trust.card2Title'), body: t('trust.card2Body') },
    { title: t('trust.card3Title'), body: t('trust.card3Body') },
  ]

  const heroChips = ['creators', 'brands', 'community', 'stockholm', 'reach'] as const
  const chipKeys = ['gym', 'food', 'study', 'travel', 'fashion', 'gaming', 'nightlife', 'hobby'] as const

  return (
    <>
      {/* 1. Hero */}
      <section className="section pt-10">
        <div className="wrap grid gap-10 md:grid-cols-[1.15fr_1fr] md:items-center">
          <div>
            <ul className="flex flex-wrap gap-2 mb-6" aria-label={t('eyebrow')}>
              {heroChips.map((key) => (
                <li key={key} className="chip chip-ink text-xs min-h-8 py-1">
                  {t(`hero.chips.${key}`)}
                </li>
              ))}
            </ul>
            <h1 className="display text-[2.75rem] sm:text-6xl lg:text-7xl mb-6">
              {t.rich('hero.title', { brand: (chunks) => <span className="brush">{chunks}</span> })}
            </h1>
            <p className="text-lg text-[var(--color-ink-2)] mb-8 max-w-prose">{t('hero.sub')}</p>
            <div className="flex flex-wrap gap-3">
              <a href="#waitlist" className="btn btn-primary">
                {t('hero.ctaPrimary')}
              </a>
              <a href="#how" className="btn btn-secondary">
                {t('hero.ctaLearn')}
              </a>
            </div>
            {showSignIn && (
              <p className="mt-4 text-sm text-[var(--color-ink-2)]">
                {t('hero.already')}{' '}
                <Link href="/sign-in" className="underline font-medium">
                  {t('hero.alreadyLink')}
                </Link>
              </p>
            )}
            {statItems.length > 0 && (
              <p className="mt-8 text-sm font-semibold text-[var(--color-ink-2)] flex flex-wrap gap-x-3 gap-y-1">
                {statItems.map((item, index) => (
                  <span key={item.text} className="flex items-center gap-3">
                    {index > 0 && <span aria-hidden="true">·</span>}
                    <span>{item.text}</span>
                  </span>
                ))}
              </p>
            )}
          </div>

          {/* The photo: a phone mock taped to the page with a handwritten note. */}
          <div className="relative mx-auto w-full max-w-[300px] pt-6">
            <span className="tape tape-teal -top-1 left-4 z-10" aria-hidden="true" />
            <span className="tape tape-grey -top-1 right-2 rotate-6 z-10" aria-hidden="true" />
            <PhoneMock caption={t('hero.phoneCaption')} />
            <p
              className="marker absolute -bottom-3 -right-2 sm:-right-8 rotate-[-8deg] text-2xl text-[var(--color-orange)]"
              aria-hidden="true"
            >
              {t('hero.note')}
            </p>
          </div>
        </div>
      </section>

      {/* 2. Tagline band */}
      <div className="bg-[var(--color-ink)] text-[var(--color-bg)]">
        <div className="wrap py-5 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
          <p className="display text-lg sm:text-xl">{t('lines.post')}</p>
          <p className="marker text-lg text-[var(--color-teal)]">{t('lines.internet')}</p>
        </div>
      </div>

      {/* 3. How it works */}
      <section id="how" className="section scroll-mt-16">
        <div className="wrap">
          <h2 className="display text-3xl sm:text-4xl mb-8">{t('how.title')}</h2>
          <ol className="grid gap-4 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title} className="card p-5 relative overflow-hidden">
                <div className="flex items-center justify-between mb-4">
                  <StepIcon kind={step.icon} />
                  <span className="amount text-sm text-[var(--color-ink-3)] font-semibold">0{index + 1}</span>
                </div>
                <h3 className="text-xl mb-1">{step.title}</h3>
                <p className="text-sm text-[var(--color-ink-2)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 4. Estimator */}
      <div className="border-t border-[var(--color-line)]">
        <Estimator />
      </div>

      {/* 5. Trust */}
      <section className="section border-t border-[var(--color-line)]">
        <div className="wrap">
          <h2 className="display text-3xl sm:text-4xl mb-8">{t('trust.title')}</h2>
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

      {/* 6. Community */}
      <section id="community" className="section border-t border-[var(--color-line)] scroll-mt-16">
        <div className="wrap">
          <h2 className="display text-3xl sm:text-4xl mb-2">{t('who.title')}</h2>
          <p className="text-lg text-[var(--color-ink-2)] mb-6">{t('who.line')}</p>
          <ul className="flex flex-wrap gap-2 mb-8">
            {chipKeys.map((key) => (
              <li key={key} className="chip">
                {t(`who.chips.${key}`)}
              </li>
            ))}
          </ul>
          <p className="marker text-2xl sm:text-3xl text-[var(--color-teal-dk)] rotate-[-1.5deg] inline-block">
            {t('lines.further')}
          </p>
        </div>
      </section>

      {/* 7. FAQ */}
      <div className="border-t border-[var(--color-line)]">
        <Faq />
      </div>

      {/* 8. Waitlist */}
      <div className="border-t border-[var(--color-line)] bg-[var(--color-surface)]">
        <WaitlistForm />
      </div>

      {/* 9. Footer bar */}
      <div className="border-t border-[var(--color-line)]">
        <div className="wrap py-10 text-center">
          <p className="display text-2xl sm:text-4xl">
            <span className="rule-teal px-1">{t('lines.footer')}</span>
          </p>
          <div className="mt-6">
            <Link href="/brands" className="btn btn-ink">
              {t('hero.ctaSecondary')} →
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}
