import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { BrandEnquiryForm } from '@/components/marketing/BrandEnquiryForm'
import { formatKrDown } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'

// Dynamic for the same reason as the landing page: the locale lives in a cookie.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('brands')
  return { title: t('metaTitle'), description: t('metaDescription') }
}

/** /brands — docs/01. Brand side uses the blue accent, numbers first (docs/10). */
export default async function BrandsPage() {
  const t = await getTranslations('brands')

  const steps = [t('how.step1'), t('how.step2'), t('how.step3'), t('how.step4')]

  // Illustrative until campaign 1 reports real figures — labelled as such (docs/01).
  const stats = [
    { label: t('stats.participants'), value: '300+' },
    { label: t('stats.placements'), value: '500+' },
    { label: t('stats.cpm'), value: `${formatKrDown(DEFAULTS.cpmOre)}–${formatKrDown(DEFAULTS.cpmOre + 4000)}` },
  ]

  return (
    <>
      <section className="section pt-10">
        <div className="wrap max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-blue)] mb-4">
            NOD · Stockholm beta
          </p>
          <h1 className="text-4xl sm:text-5xl leading-[1.05] mb-5">{t('hero.title')}</h1>
          <p className="text-lg text-[var(--color-ink-2)] mb-8">{t('hero.sub')}</p>
          <a
            href="#enquiry"
            className="btn text-white"
            style={{ background: 'var(--color-blue)' }}
          >
            {t('hero.cta')}
          </a>
        </div>
      </section>

      <section className="section border-t border-[var(--color-line)]">
        <div className="wrap">
          <p className="text-xs uppercase tracking-widest text-[var(--color-ink-3)] mb-4">
            {t('stats.illustrative')}
          </p>
          <ul className="grid gap-4 sm:grid-cols-3">
            {stats.map((stat) => (
              <li key={stat.label} className="card p-5">
                <p className="amount text-3xl font-bold mb-1">{stat.value}</p>
                <p className="text-sm text-[var(--color-ink-2)]">{stat.label}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section border-t border-[var(--color-line)]">
        <div className="wrap">
          <h2 className="text-2xl sm:text-3xl mb-8">{t('how.title')}</h2>
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, index) => (
              <li key={step} className="card p-5">
                <span className="amount text-sm font-semibold" style={{ color: 'var(--color-blue)' }}>
                  0{index + 1}
                </span>
                <p className="mt-2 text-sm">{step}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section border-t border-[var(--color-line)]">
        <div className="wrap max-w-2xl">
          <h2 className="text-2xl sm:text-3xl mb-3">{t('pricing.title')}</h2>
          <p className="text-lg text-[var(--color-ink-2)]">{t('pricing.body')}</p>
        </div>
      </section>

      <div className="border-t border-[var(--color-line)] bg-[var(--color-surface)]">
        <BrandEnquiryForm />
      </div>
    </>
  )
}
