'use server'

import { cookies } from 'next/headers'
import { DEV_AUTH_COOKIE, devAuthAllowed } from '@/lib/auth'

/**
 * Sets the development session cookie. Refuses outright in production — the cookie is
 * also ignored there, but an action that can set a session must fail loudly rather
 * than quietly doing nothing.
 */
export async function setDevPersona(authId: string): Promise<void> {
  if (!devAuthAllowed()) throw new Error('Dev personas are not available in production')

  const store = await cookies()
  store.set(DEV_AUTH_COOKIE, authId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8,
  })
}

export async function clearDevPersona(): Promise<void> {
  if (!devAuthAllowed()) return
  const store = await cookies()
  store.delete(DEV_AUTH_COOKIE)
}
