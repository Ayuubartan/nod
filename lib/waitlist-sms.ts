/**
 * SMS for the waitlist game — docs/13 "SMS for meaningful events, aggregated".
 *
 * Three kinds, all behind the `waitlist.smsEnabled` flag because each costs money:
 *
 *   waitlistVerify   a six-digit code that proves the number. Transactional — the
 *                    person just asked for it — so it needs no marketing consent.
 *   waitlistDigest   one message covering everything that happened since the last one
 *                    (friends verified, level reached, rank moved). Never one SMS per
 *                    movement; never more often than every six hours; never at night.
 *   waitlistAccess   "your turn" — sent the moment ops grants access, with the link.
 *
 * Digest and access messages go only to people who ticked the separate SMS box and
 * have not replied STOP (inbound webhook, app/api/webhooks/sms). Every send records
 * `lastSmsAt`, so the cadence rule holds across restarts.
 *
 * Swedish only, on purpose: the pilot audience is Swedish and an SMS has no locale
 * cookie. The "– Boogaa" sign-off is the sender name where the carrier shows one.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { WaitlistEntry, WaitlistEvent } from '@prisma/client'
import { BRAND } from './brand'
import { prisma } from './db'
import { flag } from './flags'
import { sendSms } from './integrations/sms'
import { sendAccessGranted } from './email'
import { LEVELS, nextLevel, normalisePhone, rankOf, type Rank } from './queue'
import { queueLink } from './queue-session'
import { rateLimit } from './rate-limit'

export const PHONE_CODE_TTL_MS = 10 * 60 * 1000
export const PHONE_MAX_ATTEMPTS = 5
export const DIGEST_MIN_GAP_MS = 6 * 60 * 60 * 1000
/** Quiet hours, Europe/Stockholm: nothing between 22:00 and 08:00. */
export const QUIET_FROM = 22
export const QUIET_UNTIL = 8

const LEVEL_NAMES: Record<string, string> = {
  queue: 'I kön',
  connector: 'Connector',
  social: 'Social',
  insider: 'Insider',
  founding: 'Founding member',
}

export function levelName(key: string): string {
  return LEVEL_NAMES[key] ?? key
}

/** Whether an SMS may go out right now, Stockholm time. */
export function isQuietHour(now = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Stockholm' }).format(now))
  return hour >= QUIET_FROM || hour < QUIET_UNTIL
}

/** Marketing-class messages need the flag, the consent, no STOP, and a phone. */
export function mayReceiveDigest(
  entry: Pick<WaitlistEntry, 'phone' | 'smsConsentAt' | 'smsOptOutAt' | 'lastSmsAt'>,
  now = new Date(),
): boolean {
  if (!entry.phone || !entry.smsConsentAt || entry.smsOptOutAt) return false
  if (entry.lastSmsAt && now.getTime() - entry.lastSmsAt.getTime() < DIGEST_MIN_GAP_MS) return false
  return !isQuietHour(now)
}

// ---------------------------------------------------------------- verification

function hashPhoneCode(phone: string, code: string): string {
  const key = process.env.ENCRYPTION_KEY ?? 'nod-dev-only'
  return createHmac('sha256', key).update(`phone:${phone}:${code}`).digest('hex')
}

export type PhoneCodeResult =
  | { ok: true; /** Only when no SMS went out (no provider / flag off outside production). */ devCode?: string }
  | { ok: false; error: 'rateLimited' | 'smsUnavailable' | 'phoneTaken' }

/**
 * Sends a code to a number. The number is not written to the entry until the code
 * is confirmed, so a typo never claims somebody else's phone.
 */
export async function requestPhoneCode(entry: Pick<WaitlistEntry, 'id'>, phone: string): Promise<PhoneCodeResult> {
  if (!(await rateLimit(`phone:${phone}`, 3, 15 * 60_000))) return { ok: false, error: 'rateLimited' }
  const taken = await prisma.waitlistEntry.findFirst({
    where: { phone, phoneVerifiedAt: { not: null }, deletedAt: null, id: { not: entry.id } },
    select: { id: true },
  })
  if (taken) return { ok: false, error: 'phoneTaken' }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0')
  const now = new Date()
  await prisma.$transaction([
    prisma.phoneCode.updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: now } }),
    prisma.phoneCode.create({
      data: { phone, codeHash: hashPhoneCode(phone, code), expiresAt: new Date(now.getTime() + PHONE_CODE_TTL_MS) },
    }),
  ])

  const enabled = await flag('waitlist.smsEnabled')
  if (enabled) {
    const result = await sendSms('waitlistVerify', phone, `${code} är din kod hos ${BRAND}. Gäller i 10 minuter.`)
    if (result.ok) return { ok: true }
  }
  // Same rule as the login code: outside production the code may be shown on the page.
  if (process.env.NODE_ENV !== 'production' || process.env.NOD_DEMO_LOGIN_CODE === '1') return { ok: true, devCode: code }
  return { ok: false, error: 'smsUnavailable' }
}

export type VerifyPhoneResult = { ok: true } | { ok: false; error: 'noCode' | 'wrongCode' | 'tooManyAttempts' | 'rateLimited' }

export async function verifyPhoneCode(phone: string, rawCode: string): Promise<VerifyPhoneResult> {
  if (!(await rateLimit(`phone-verify:${phone}`, 20, 15 * 60_000))) return { ok: false, error: 'rateLimited' }
  const code = rawCode.replace(/\D/g, '')
  const row = await prisma.phoneCode.findFirst({
    where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return { ok: false, error: 'noCode' }
  if (row.attempts >= PHONE_MAX_ATTEMPTS) return { ok: false, error: 'tooManyAttempts' }

  const expected = Buffer.from(row.codeHash, 'hex')
  const actual = Buffer.from(hashPhoneCode(phone, code), 'hex')
  if (code.length !== 6 || !timingSafeEqual(expected, actual)) {
    const updated = await prisma.phoneCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } })
    return { ok: false, error: updated.attempts >= PHONE_MAX_ATTEMPTS ? 'tooManyAttempts' : 'wrongCode' }
  }
  await prisma.phoneCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } })
  return { ok: true }
}

// ---------------------------------------------------------------- messages

export type DigestInput = {
  entry: Pick<WaitlistEntry, 'verifiedReferrals' | 'lastNotifiedRank'>
  events: Pick<WaitlistEvent, 'type' | 'data'>[]
  rank: Rank
}

/**
 * One message for everything since last time, or null when nothing is worth a
 * text. Friends who joined but have not verified yet are not mentioned — the
 * number in the message must be the number that counted (docs/13 "never fake").
 */
export function composeDigest({ entry, events, rank }: DigestInput): string | null {
  const friends = events.filter((e) => e.type === 'FRIEND_VERIFIED' && (e.data as { counted?: boolean } | null)?.counted).length
  const levelEvent = events.filter((e) => e.type === 'LEVEL_UNLOCKED').at(-1)
  const boosts = events.filter((e) => e.type === 'REWARD_UNLOCKED')
  const moved = entry.lastNotifiedRank !== null && entry.lastNotifiedRank > rank.rank ? entry.lastNotifiedRank - rank.rank : 0

  if (friends === 0 && !levelEvent && boosts.length === 0) return null

  const parts: string[] = []
  if (friends === 1) parts.push('En vän gick med via dig')
  else if (friends > 1) parts.push(`${friends} vänner gick med via dig`)
  if (boosts.length > 0) parts.push('du fick dagens boost')
  const lead = parts.length > 0 ? parts.join(' och ') : 'Nyheter i kön'

  const movement = moved > 0 ? ` – du hoppade ${moved} platser till #${rank.rank}` : ` – du är #${rank.rank}`
  let text = `${lead}${movement}.`

  if (levelEvent) {
    const key = (levelEvent.data as { key?: string } | null)?.key ?? ''
    const level = LEVELS.find((l) => l.key === key)
    text += level?.priority ? ` Du är nu ${levelName(key)} med prioriterad access!` : ` Du är nu ${levelName(key)}!`
  } else {
    const next = nextLevel(entry.verifiedReferrals)
    if (next && next.remaining === 1) text += ` En vän till → ${levelName(next.level.key)}.`
  }
  return `${text} – ${BRAND}`
}

export function accessMessage(link: string): string {
  return `DIN TUR! ${BRAND} öppnar för dig nu. Din invite gäller i 48h: ${link} – ${BRAND}`
}

/**
 * Sends and records one marketing-class message; a no-op unless the flag and the
 * person both allow it. The caller decides what to say.
 */
export async function sendWaitlistSms(
  entry: Pick<WaitlistEntry, 'id' | 'phone'>,
  kind: 'waitlistDigest' | 'waitlistAccess',
  message: string,
): Promise<boolean> {
  if (!entry.phone) return false
  if (!(await flag('waitlist.smsEnabled'))) return false
  const result = await sendSms(kind, entry.phone, message)
  if (!result.ok) return false
  await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { lastSmsAt: new Date() } })
  return true
}

/**
 * The 15-minute sweep: everyone with unannounced events gets at most one text,
 * then those events are marked told. For people who cannot be texted (no consent,
 * STOP, no phone) the events are marked told straight away — the page has shown
 * them anyway, and nobody must accumulate a backlog that fires the day they tick
 * the box. Quiet hours and the six-hour gap postpone instead.
 */
export async function runDigest(now = new Date()): Promise<{ sent: number; considered: number }> {
  const pending = await prisma.waitlistEvent.groupBy({
    by: ['entryId'],
    where: { notifiedAt: null, type: { in: ['FRIEND_VERIFIED', 'LEVEL_UNLOCKED', 'REWARD_UNLOCKED'] } },
    _count: { _all: true },
    orderBy: { entryId: 'asc' },
    take: 500,
  })
  let sent = 0
  for (const group of pending) {
    const entry = await prisma.waitlistEntry.findFirst({ where: { id: group.entryId, deletedAt: null } })
    if (!entry) continue

    const textable = Boolean(entry.phone && entry.smsConsentAt && !entry.smsOptOutAt)
    if (textable && !mayReceiveDigest(entry, now)) continue

    const events = await prisma.waitlistEvent.findMany({
      where: { entryId: entry.id, notifiedAt: null },
      orderBy: { createdAt: 'asc' },
    })
    if (textable) {
      const rank = await rankOf(entry)
      const message = composeDigest({ entry, events, rank })
      if (message && (await sendWaitlistSms(entry, 'waitlistDigest', message))) {
        sent++
        await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { lastNotifiedRank: rank.rank } })
      }
    }
    await prisma.waitlistEvent.updateMany({
      where: { id: { in: events.map((e) => e.id) } },
      data: { notifiedAt: now },
    })
  }
  return { sent, considered: pending.length }
}

/** Access granted: SMS now (if allowed), the email always. */
export async function announceAccess(entry: WaitlistEntry): Promise<void> {
  const link = queueLink(entry.id, 'sms')
  if (entry.smsConsentAt && !entry.smsOptOutAt && entry.phone) {
    await sendWaitlistSms(entry, 'waitlistAccess', accessMessage(link))
  }
  await sendAccessGranted({ email: entry.email, link: queueLink(entry.id, 'email'), expiresAt: entry.accessExpiresAt })
  await prisma.waitlistEvent.updateMany({
    where: { entryId: entry.id, type: 'ACCESS_GRANTED', notifiedAt: null },
    data: { notifiedAt: new Date() },
  })
}

/** STOP / STOPP / SLUTA from a number ends marketing texts to every entry on it. */
export async function handleInboundSms(from: string, message: string): Promise<number> {
  const word = message.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
  if (!['STOP', 'STOPP', 'SLUTA', 'AVSLUTA'].includes(word)) return 0
  const phone = normalisePhone(from) ?? from
  const result = await prisma.waitlistEntry.updateMany({
    where: { phone, smsOptOutAt: null, deletedAt: null },
    data: { smsOptOutAt: new Date() },
  })
  return result.count
}
