import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { LanguageToggle } from '@/components/LanguageToggle'
import { AnalyticsProvider } from '@/components/AnalyticsProvider'

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('marketing')
  const nav = await getTranslations('nav')

  return (
    <AnalyticsProvider>
      <div className="min-h-dvh flex flex-col">
        <header className="border-b border-[var(--color-line)]">
          <div className="wrap flex items-center justify-between h-14">
            <Link href="/" className="font-[family-name:var(--font-display)] font-extrabold text-lg tracking-tight">
              NOD
            </Link>
            <div className="flex items-center gap-4 text-sm">
              <Link href="/brands" className="text-[var(--color-ink-2)] hover:text-[var(--color-ink)]">
                {nav('forBrands')}
              </Link>
              <LanguageToggle />
            </div>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-[var(--color-line)] mt-8">
          <div className="wrap py-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between text-sm text-[var(--color-ink-2)]">
            <div className="flex items-center gap-2">
              <span className="nod-marker" aria-hidden="true" />
              <span className="font-semibold text-[var(--color-ink)]">NOD</span>
              <span>· {t('footer.city')}</span>
            </div>
            <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <a href="mailto:hello@nod.se">hello@nod.se</a>
              <Link href="/privacy">{t('footer.privacy')}</Link>
              <Link href="/terms">{t('footer.terms')}</Link>
              <Link href="/cookies">{t('footer.cookies')}</Link>
              <Link href="/brand-agreement">{t('footer.brandAgreement')}</Link>
              <Link href="/brands">{t('hero.ctaSecondary')}</Link>
              <LanguageToggle />
            </nav>
          </div>
        </footer>
      </div>
    </AnalyticsProvider>
  )
}
