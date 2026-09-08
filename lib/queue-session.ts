/**
 * Who is looking at /queue.
 *
 * Nobody on the waitlist has an account, so there is no NOD_SESSION to lean on.
 * Instead every link we send — the confirmation mail, an SMS, "email me my link" —
 * carries a signed token naming the entry, and opening it sets a NOD_QUEUE cookie
 * so the page keeps working without the token in the URL. Same shape and key
 * derivation as lib/session.ts; a different purpose string so one can never be
 * replayed as the other.
 *
 * Opening a token that arrived by email also proves the address, which is why the
 * token records how it was sent (`via`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'

export const QUEUE_COOKIE = 'NOD_QUEUE'
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 90
export const LINK_TTL_S = 60 * 60 * 24 * 30

export type QueueToken = {
  entryId: string
  via: 'email' | 'sms' | 'cookie'
  /** Unix seconds. */
  exp: number
}

function signingKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    if (process.env.NODE_ENV === 'production') throw new Error('ENCRYPTION_KEY is not set')
    return createHmac('sha256', 'nod-dev-only').update('queue').digest()
  }
  return createHmac('sha256', Buffer.from(raw, 'base64')).update('queue').digest()
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const sign = (body: string) => b64(createHmac('sha256', signingKey()).update(body).digest())

export function encodeQueueToken(payload: QueueToken): string {
  const body = b64(JSON.stringify(payload))
  return `${body}.${sign(body)}`
}

/** Null on any defect — bad signature, expiry, garbage. Never throws. */
export function decodeQueueToken(value: string | undefined | null, now = Date.now()): QueueToken | null {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const body = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = sign(body)
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<QueueToken>
    if (typeof parsed.entryId !== 'string' || typeof parsed.exp !== 'number') return null
    if (parsed.via !== 'email' && parsed.via !== 'sms' && parsed.via !== 'cookie') return null
    if (parsed.exp * 1000 <= now) return null
    return { entryId: parsed.entryId, via: parsed.via, exp: parsed.exp }
  } catch {
    return null
  }
}

/** A link to /queue that identifies this entry for 30 days. */
export function queueLink(entryId: string, via: 'email' | 'sms'): string {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const token = encodeQueueToken({ entryId, via, exp: Math.floor(Date.now() / 1000) + LINK_TTL_S })
  return `${siteUrl}/queue?t=${token}`
}

export async function setQueueCookie(entryId: string): Promise<void> {
  const store = await cookies()
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_S
  store.set(QUEUE_COOKIE, encodeQueueToken({ entryId, via: 'cookie', exp }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
  })
}

export async function readQueueCookie(): Promise<string | null> {
  const store = await cookies()
  return decodeQueueToken(store.get(QUEUE_COOKIE)?.value)?.entryId ?? null
}

export async function clearQueueCookie(): Promise<void> {
  const store = await cookies()
  store.delete(QUEUE_COOKIE)
}
