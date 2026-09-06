'use server'

import { cookies } from 'next/headers'
import { isLocale, LOCALE_COOKIE } from './config'

/** Language toggle. One year, lax, so a shared link keeps the reader's choice. */
export async function setLocale(next: string): Promise<void> {
  if (!isLocale(next)) return
  const store = await cookies()
  store.set(LOCALE_COOKIE, next, {
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/',
    httpOnly: false,
  })
}
