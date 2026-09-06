export const LOCALES = ['sv', 'en'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'sv'
export const LOCALE_COOKIE = 'NOD_LOCALE'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * Pick a locale from an Accept-Language header. Swedish wins ties — the pilot is
 * Stockholm, and the brand voice is Swedish-first even in English (docs/10).
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE
  const parsed = header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.find((p) => p.trim().startsWith('q='))
      const quality = q ? Number.parseFloat(q.split('=')[1] ?? '1') : 1
      return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0 }
    })
    .sort((a, b) => b.quality - a.quality)

  for (const { tag } of parsed) {
    const base = tag.split('-')[0]
    if (base === 'sv') return 'sv'
    if (base === 'en') return 'en'
  }
  return DEFAULT_LOCALE
}

export const CURRENCY_LOCALE: Record<Locale, string> = { sv: 'sv-SE', en: 'en-GB' }
