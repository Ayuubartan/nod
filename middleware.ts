import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { LOCALE_COOKIE, isLocale, localeFromAcceptLanguage } from '@/lib/i18n/config'

/**
 * Two jobs:
 *   1. Refresh the Supabase session cookie, which Server Components cannot write.
 *   2. Pin the locale on first visit, so the whole render tree agrees on a language
 *      and there is no flash of the wrong copy (docs/01).
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  // Locale: cookie wins, otherwise Accept-Language, once, on the first request.
  const existing = request.cookies.get(LOCALE_COOKIE)?.value
  if (!isLocale(existing)) {
    const locale = localeFromAcceptLanguage(request.headers.get('accept-language'))
    response.cookies.set(LOCALE_COOKIE, locale, {
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      path: '/',
    })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return response

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => {
        for (const { name, value } of toSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options as never)
        }
      },
    },
  })

  // Touching getUser() is what refreshes an expiring session.
  await supabase.auth.getUser()

  return response
}

export const config = {
  matcher: [
    // Everything except static assets and the media proxy, which does its own auth.
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|api/media|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
