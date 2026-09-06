'use client'

import { useTranslations } from 'next-intl'

/** FAQ accordion — docs/01 section 6. Native <details> so it works with no JS and is keyboard-navigable. */
export function Faq() {
  const t = useTranslations('marketing.faq')
  const items = [1, 2, 3, 4, 5, 6, 7] as const

  return (
    <section className="section">
      <div className="wrap max-w-2xl">
        <h2 className="text-2xl sm:text-3xl mb-6">{t('title')}</h2>
        <div className="grid gap-2">
          {items.map((n) => (
            <details key={n} className="card px-5 py-4 group">
              <summary className="cursor-pointer list-none font-semibold flex items-center justify-between gap-4">
                {t(`q${n}` as never)}
                <span className="text-[var(--color-ink-3)] group-open:rotate-45 transition-transform" aria-hidden="true">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm text-[var(--color-ink-2)]">{t(`a${n}` as never)}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
