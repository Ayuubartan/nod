import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { LanguageToggle } from '@/components/LanguageToggle'

/** Brand shell — blue accent, denser layout, numbers first (docs/10). */
export default async function BrandLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('brandApp')

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="border-b border-[var(--color-line)]">
        <div className="wrap max-w-6xl flex items-center justify-between h-14">
          <div className="flex items-center gap-6">
            <Link href="/brand/campaigns" className="font-[family-name:var(--font-display)] font-extrabold text-lg">
              NOD
            </Link>
            <nav className="flex gap-4 text-sm">
              <Link href="/brand/campaigns" className="text-[var(--color-ink-2)] hover:text-[var(--color-ink)]">
                {t('campaigns')}
              </Link>
              <Link href="/brand/settings" className="text-[var(--color-ink-2)] hover:text-[var(--color-ink)]">
                NOD
              </Link>
            </nav>
          </div>
          <LanguageToggle />
        </div>
      </header>
      <main className="flex-1 wrap max-w-6xl py-8">{children}</main>
    </div>
  )
}
