import Link from 'next/link'
import { BRAND } from '@/lib/brand'
import { getTranslations } from 'next-intl/server'
import { requireOps } from '@/lib/auth'
import { SignOutButton } from '@/components/SignOutButton'

/** Ops console — docs/02 section C: "Internal, plain, fast. Tables over charts." */
export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  await requireOps()
  const t = await getTranslations('ops')

  const nav = [
    { href: '/ops/campaigns', label: t('campaignReview') },
    { href: '/ops/generation', label: t('generation') },
    { href: '/ops/verification', label: t('verification') },
    { href: '/ops/payouts', label: t('payouts') },
    { href: '/ops/participants', label: t('participants') },
    { href: '/ops/signups', label: t('signups') },
    { href: '/ops/waitlist', label: t('waitlist') },
    { href: '/ops/brands', label: t('brands') },
    { href: '/ops/flags', label: t('flags') },
    { href: '/ops/audit', label: t('audit') },
  ]

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)]">
        <div className="wrap max-w-7xl flex items-center gap-6 h-12">
          <span className="font-[family-name:var(--font-display)] font-extrabold text-sm">
            {BRAND} {t('console')}
          </span>
          <nav className="flex gap-4 text-xs overflow-x-auto">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-[var(--color-ink-2)] hover:text-[var(--color-ink)] whitespace-nowrap"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <SignOutButton className="ml-auto text-xs" />
        </div>
      </header>
      <main className="flex-1 wrap max-w-7xl py-6">{children}</main>
    </div>
  )
}
