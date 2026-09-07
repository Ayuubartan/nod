import Link from 'next/link'
import { BRAND } from '@/lib/brand'
import { LanguageToggle } from '@/components/LanguageToggle'

/** Sign-in shell: wordmark and language, nothing to navigate to until you are in. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="border-b border-[var(--color-line)]">
        <div className="wrap flex items-center justify-between h-14">
          <Link href="/" className="font-[family-name:var(--font-display)] font-extrabold text-lg tracking-tight">
            {BRAND}
          </Link>
          <LanguageToggle />
        </div>
      </header>
      <main className="flex-1 wrap py-10">{children}</main>
    </div>
  )
}
