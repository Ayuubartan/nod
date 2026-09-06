import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { AnalyticsProvider } from '@/components/AnalyticsProvider'
import { LanguageToggle } from '@/components/LanguageToggle'

/** Participant shell — bottom tab bar, because this is a phone-first PWA (docs/02). */
export default async function ParticipantLayout({ children }: { children: React.ReactNode }) {
  const nav = await getTranslations('nav')

  const tabs = [
    { href: '/campaigns', label: nav('campaigns') },
    { href: '/placements', label: nav('placements') },
    { href: '/wallet', label: nav('wallet') },
    { href: '/settings', label: nav('settings') },
  ]

  return (
    <AnalyticsProvider>
      <div className="min-h-dvh flex flex-col pb-16">
        <header className="border-b border-[var(--color-line)] sticky top-0 bg-[var(--color-bg)] z-10">
          <div className="wrap flex items-center justify-between h-14">
            <Link href="/campaigns" className="font-[family-name:var(--font-display)] font-extrabold text-lg">
              NOD
            </Link>
            <LanguageToggle />
          </div>
        </header>

        <main className="flex-1 wrap py-6">{children}</main>

        <nav
          className="fixed bottom-0 inset-x-0 border-t border-[var(--color-line)] bg-[var(--color-surface)]"
          aria-label="Main"
        >
          <ul className="wrap grid grid-cols-4">
            {tabs.map((tab) => (
              <li key={tab.href}>
                <Link
                  href={tab.href}
                  className="flex items-center justify-center h-16 text-xs font-medium text-[var(--color-ink-2)]"
                >
                  {tab.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </AnalyticsProvider>
  )
}
