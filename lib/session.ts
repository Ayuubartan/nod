/**
 * NOD's own session cookie — the thing a sign-in code turns into.
 *
 * docs/08 names Supabase Auth for social sign-in (Google, Apple) and lib/auth.ts still
 * honours a Supabase session when one is configured. The email-code flow does not need
 * a provider at all, so it issues a signed cookie of its own:
 *
 *   NOD_SESSION = base64url(json) "." base64url(hmac-sha256(json))
 *
 * The payload carries the auth id, the email it was proved with, and an expiry. It is
 * signed, not encrypted — nothing in it is secret — and a bad signature reads as no
 * session at all. The signing key is derived from ENCRYPTION_KEY, which production must
 * already have, so there is one secret to rotate rather than two.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'

export const SESSION_COOKIE = 'NOD_SESSION'
const MAX_AGE_S = 60 * 60 * 24 * 30

export type SessionPayload = {
  authId: string
  email: string
  /**
   * Display name, when a social provider supplied one. Optional and absent from every
   * cookie the email-code flow issues, so an older cookie still decodes — it rides here
   * because a first-time social sign-in has no User row yet to put it on; onboarding
   * creates that row and takes the name from the session (docs/07 data table).
   */
  name?: string
  /** Unix seconds. */
  exp: number
}

// DECISION: derive rather than add AUTH_SECRET. Two secrets that must both be set and
// rotated together is one more way to misconfigure a deploy. Outside production a
// fixed dev key keeps `pnpm dev` working with an empty .env.
function signingKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    if (process.env.NODE_ENV === 'production') throw new Error('ENCRYPTION_KEY is not set')
    return createHmac('sha256', 'nod-dev-only').update('session').digest()
  }
  return createHmac('sha256', Buffer.from(raw, 'base64')).update('session').digest()
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')

function sign(body: string): string {
  return b64(createHmac('sha256', signingKey()).update(body).digest())
}

/** Serialises and signs a payload. Exported for tests; callers use setSession. */
export function encodeSession(payload: SessionPayload): string {
  const body = b64(JSON.stringify(payload))
  return `${body}.${sign(body)}`
}

/** Verifies the signature and expiry; null on any defect. Never throws on bad input. */
export function decodeSession(value: string | undefined | null, now = Date.now()): SessionPayload | null {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const body = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = sign(body)
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionPayload>
    if (typeof parsed.authId !== 'string' || typeof parsed.email !== 'string' || typeof parsed.exp !== 'number') return null
    if (parsed.exp * 1000 <= now) return null
    const name = typeof parsed.name === 'string' && parsed.name ? parsed.name.slice(0, 100) : undefined
    return { authId: parsed.authId, email: parsed.email, exp: parsed.exp, ...(name ? { name } : {}) }
  } catch {
    return null
  }
}

export async function setSession(authId: string, email: string, name?: string | null): Promise<void> {
  const store = await cookies()
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S
  const trimmed = name?.trim().slice(0, 100)
  store.set(SESSION_COOKIE, encodeSession({ authId, email, exp, ...(trimmed ? { name: trimmed } : {}) }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_S,
  })
}

export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies()
  return decodeSession(store.get(SESSION_COOKIE)?.value)
}

export async function clearSession(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
}
