import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, localeFromAcceptLanguage, type Locale } from './config'

/**
 * Locale resolution, in order: explicit cookie -> Accept-Language -> sv.
 * No locale prefix in the URL: the pilot audience arrives from Instagram in-app
 * browsers on shared links, and a /sv/ prefix breaks those links when the language
 * toggle is used (docs/01 "Language toggle sv/en, default from Accept-Language,
 * persisted in cookie").
 */
export async function resolveLocale(): Promise<Locale> {
  const cookieStore = await cookies()
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value
  if (isLocale(fromCookie)) return fromCookie

  const headerStore = await headers()
  return localeFromAcceptLanguage(headerStore.get('accept-language'))
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale().catch(() => DEFAULT_LOCALE)
  const messages = (await import(`./${locale}.json`)).default
  return { locale, messages, timeZone: 'Europe/Stockholm' }
})
