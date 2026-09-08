'use client'

import { useLocale } from 'next-intl'
import { useTransition } from 'react'
import { setLocale } from '@/lib/i18n/actions'
import { LOCALES } from '@/lib/i18n/config'

/** sv/en toggle. Persists to a cookie; no locale prefix in the URL (docs/01). */
export function LanguageToggle() {
  const locale = useLocale()
  const [pending, startTransition] = useTransition()

  return (
    <div className="inline-flex items-center rounded-full border border-[var(--color-line)] overflow-hidden text-xs">
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          disabled={pending}
          aria-pressed={locale === code}
          aria-label={code === 'sv' ? 'Svenska' : 'English'}
          onClick={() => startTransition(() => setLocale(code).then(() => window.location.reload()))}
          className={
            locale === code
              ? 'px-2.5 py-1 bg-[var(--color-teal)] text-[#111820] font-semibold'
              : 'px-2.5 py-1 text-[var(--color-ink-2)]'
          }
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
