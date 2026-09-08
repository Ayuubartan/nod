/**
 * Email one-time code sign-in, for creators and brand users alike.
 *
 * Two steps. `requestCode` mails a six-digit code and stores only its HMAC, with a ten
 * minute expiry. `verifyCode` checks it in constant time, allows five wrong guesses per
 * code, consumes it on success and resolves who just signed in:
 *
 *   BRAND        — the email must already belong to a BrandUser. Ops creates brand
 *                  accounts (docs/09 "Not in scope": no self-serve brand signup), so an
 *                  unknown email is told so rather than given an empty account.
 *   PARTICIPANT  — an existing User signs straight in; a new email gets a fresh auth id
 *                  and lands in onboarding, which creates the User row (docs/02 A1).
 *
 * The session itself is lib/session.ts. This module never touches cookies, so it can
 * be tested against the database without a request.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { LoginAudience } from '@prisma/client'
import { prisma } from './db'
import { loginCodeEmail } from './email'
import type { Locale } from './i18n/config'
import { flag } from './flags'
import { hasAccess } from './queue'
import { rateLimit } from './rate-limit'
import { randomToken } from './crypto'

export const CODE_TTL_MS = 10 * 60 * 1000
export const MAX_ATTEMPTS = 5

export type LoginError =
  | 'invalidEmail'
  | 'rateLimited'
  | 'noCode'
  | 'wrongCode'
  | 'tooManyAttempts'
  | 'noBrandAccount'
  | 'waitlistOnly'

export type RequestResult =
  | { ok: true; /** Only set when no mail was sent; in production only with NOD_DEMO_LOGIN_CODE=1. */ devCode?: string }
  | { ok: false; error: LoginError }

export type VerifyResult =
  | { ok: true; authId: string; email: string; next: string }
  | { ok: false; error: LoginError }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  return EMAIL.test(email) && email.length <= 254 ? email : null
}

function hashCode(email: string, audience: LoginAudience, code: string): string {
  // Keyed with ENCRYPTION_KEY (or a dev constant) so a database dump alone cannot be
  // brute-forced over the million possible codes.
  const key = process.env.ENCRYPTION_KEY ?? 'nod-dev-only'
  return createHmac('sha256', key).update(`${audience}:${email}:${code}`).digest('hex')
}

export async function requestCode(
  rawEmail: string,
  audience: LoginAudience,
  locale: Locale,
): Promise<RequestResult> {
  const email = normaliseEmail(rawEmail)
  if (!email) return { ok: false, error: 'invalidEmail' }
  if (!(await rateLimit(`login:${audience}:${email}`, 5, 15 * 60_000))) return { ok: false, error: 'rateLimited' }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  const now = new Date()

  await prisma.$transaction([
    // A new request supersedes any code still open for this address.
    prisma.loginCode.updateMany({
      where: { email, audience, consumedAt: null, deletedAt: null },
      data: { consumedAt: now },
    }),
    prisma.loginCode.create({
      data: { email, audience, codeHash: hashCode(email, audience, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS) },
    }),
  ])

  const { sent } = await loginCodeEmail(email, code, locale)
  // DECISION: a demo deploy without a mail provider would otherwise be unenterable, so
  // NOD_DEMO_LOGIN_CODE=1 lets production show the code on the page — only while no
  // mail was sent. Setting RESEND_API_KEY makes the mail go out and the hint vanish.
  const demo = process.env.NOD_DEMO_LOGIN_CODE === '1'
  const showCode = !sent && (process.env.NODE_ENV !== 'production' || demo)
  return showCode ? { ok: true, devCode: code } : { ok: true }
}

export async function verifyCode(rawEmail: string, rawCode: string, audience: LoginAudience): Promise<VerifyResult> {
  const email = normaliseEmail(rawEmail)
  if (!email) return { ok: false, error: 'invalidEmail' }
  if (!(await rateLimit(`verify:${audience}:${email}`, 20, 15 * 60_000))) return { ok: false, error: 'rateLimited' }

  const code = rawCode.replace(/\D/g, '')
  const row = await prisma.loginCode.findFirst({
    where: { email, audience, consumedAt: null, deletedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return { ok: false, error: 'noCode' }
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'tooManyAttempts' }

  const expected = Buffer.from(row.codeHash, 'hex')
  const actual = Buffer.from(hashCode(email, audience, code), 'hex')
  if (code.length !== 6 || !timingSafeEqual(expected, actual)) {
    const updated = await prisma.loginCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } })
    return { ok: false, error: updated.attempts >= MAX_ATTEMPTS ? 'tooManyAttempts' : 'wrongCode' }
  }

  const identity = await resolveIdentity(email, audience)
  if (!identity.ok) return identity

  await prisma.loginCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } })
  return identity
}

/** Who this verified email is inside NOD, and where they should land. */
export async function resolveIdentity(email: string, audience: LoginAudience): Promise<VerifyResult> {
  if (audience === 'BRAND') {
    const brandUser = await prisma.brandUser.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
      select: { authId: true },
    })
    if (!brandUser) return { ok: false, error: 'noBrandAccount' }
    return { ok: true, authId: brandUser.authId, email, next: '/brand/campaigns' }
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
    select: { id: true, authId: true, role: true, state: true },
  })

  // DECISION: the address in OPS_EMAIL is the ops account. Ops users are otherwise only
  // created by the seed, which a real deploy skips (docs/12), and nobody should need a
  // database console to reach /ops. The env var is server-side, so this is no wider
  // than the deploy itself; it also upgrades an existing participant row with that
  // address rather than leaving two identities behind one email.
  const opsEmail = normaliseEmail(process.env.OPS_EMAIL ?? '')
  if (opsEmail && email === opsEmail) {
    if (user && user.role !== 'OPS') {
      await prisma.user.update({ where: { id: user.id }, data: { role: 'OPS', state: 'ACTIVE' } })
    }
    if (!user) {
      const created = await prisma.user.create({
        data: {
          authId: `email_${randomToken(12)}`,
          email,
          role: 'OPS',
          state: 'ACTIVE',
          referralCode: `OPS${randomToken(4).replace(/[^a-z0-9]/gi, 'X').toUpperCase()}`,
        },
        select: { authId: true },
      })
      return { ok: true, authId: created.authId, email, next: '/ops' }
    }
    return { ok: true, authId: user.authId, email, next: '/ops' }
  }

  if (user) {
    const next = user.role === 'OPS' ? '/ops' : user.state === 'SIGNED_UP' ? '/onboarding' : '/campaigns'
    return { ok: true, authId: user.authId, email, next }
  }

  // First visit. While the gate is up (docs/13), only people the queue has let through
  // may open an account; everyone else is sent back to their place in line. The gate
  // is a flag so ops can open the doors without a deploy.
  if ((await flag('waitlist.gate')) && !(await hasAccess(email))) return { ok: false, error: 'waitlistOnly' }

  // The auth id is minted here and the User row follows in onboarding.
  return { ok: true, authId: `email_${randomToken(12)}`, email, next: '/onboarding' }
}

/** Only same-origin paths may be used as a post-login destination. */
export function safeNext(candidate: string | null | undefined, fallback: string): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return fallback
  return candidate
}
