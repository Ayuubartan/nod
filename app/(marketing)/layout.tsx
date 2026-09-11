import Link from 'next/link'
import { HELLO_EMAIL } from '@/lib/brand'
import { getTranslations } from 'next-intl/server'
import { LanguageToggle } from '@/components/LanguageToggle'
import { AnalyticsProvider } from '@/components/AnalyticsProvider'
import { Logo } from '@/components/Logo'
import { flag } from '@/lib/flags'

/**
 * Rendered per request, not prerendered: the header reads a flag, and a flag that is
 * frozen into a static page at build time is not a flag ops can flip. The landing page
 * was already dynamic for the language cookie; this makes the legal pages match.
 */
export const dynamic = 'force-dynamic'

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('marketing')
  const nav = await getTranslations('nav')
  // Off until there are accounts to sign in to (ops flips it on /ops/flags). The page
  // itself stays reachable at /sign-in; only the links go.
  const showSignIn = await flag('marketing.showSignIn')

  // docs/10 nav: Home · Features · Community · For brands · [Join BOOGAA]
  const links = [
    { href: '/', label: t('nav.home') },
    { href: '/#how', label: t('nav.features') },
    { href: '/#community', label: t('nav.community') },
    { href: '/brands', label: t('nav.forBrands') },
  ]

  return (
    <AnalyticsProvider>
      <div className="min-h-dvh flex flex-col">
        <header className="border-b border-[var(--color-line)] bg-[var(--color-bg)]/90 backdrop-blur sticky top-0 z-20">
          <div className="wrap flex items-center justify-between h-14 gap-3">
            <Logo size={24} />
            <nav className="hidden md:flex items-center gap-5 text-sm font-medium">
              {links.map((link) => (
                <Link key={link.href} href={link.href} className="text-[var(--color-ink-2)] hover:text-[var(--color-ink)]">
                  {link.label}
                </Link>
              ))}
            </nav>
            <div className="flex items-center gap-2 sm:gap-3 text-sm">
              {showSignIn && (
                <Link
                  href="/sign-in"
                  className="text-[var(--color-ink-2)] hover:text-[var(--color-ink)] font-medium whitespace-nowrap"
                >
                  {nav('signIn')}
                </Link>
              )}
              <LanguageToggle />
              {/* Phones: the hero CTA is one thumb away, so the header keeps Sign in instead. */}
              <Link href="/#waitlist" className="btn btn-teal min-h-9 px-4 py-1.5 text-sm whitespace-nowrap hidden sm:inline-flex">
                {t('nav.join')}
              </Link>
            </div>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-[var(--color-line)] mt-8">
          <div className="wrap py-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between text-sm text-[var(--color-ink-2)]">
            <div className="flex items-center gap-2">
              <Logo size={22} />
              <span>· {t('footer.city')}</span>
            </div>
            <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <a href={`mailto:${HELLO_EMAIL}`}>{HELLO_EMAIL}</a>
              <Link href="/privacy">{t('footer.privacy')}</Link>
              <Link href="/terms">{t('footer.terms')}</Link>
              <Link href="/cookies">{t('footer.cookies')}</Link>
              <Link href="/brand-agreement">{t('footer.brandAgreement')}</Link>
              <Link href="/brands">{t('hero.ctaSecondary')}</Link>
              {showSignIn && (
                <>
                  <Link href="/sign-in">{t('footer.signIn')}</Link>
                  <Link href="/brand/sign-in">{t('footer.brandSignIn')}</Link>
                </>
              )}
              <LanguageToggle />
            </nav>
          </div>
        </footer>
      </div>
    </AnalyticsProvider>
  )
}
