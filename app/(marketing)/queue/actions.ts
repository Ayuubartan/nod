'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { sendQueueLink } from '@/lib/email'
import { normaliseEmail } from '@/lib/login'
import { markPhoneVerified, normalisePhone, updateProfile } from '@/lib/queue'
import { clearQueueCookie, queueLink, readQueueCookie } from '@/lib/queue-session'
import { rateLimit } from '@/lib/rate-limit'
import { requestPhoneCode, verifyPhoneCode } from '@/lib/waitlist-sms'

/**
 * Everything a person can do on /queue (docs/13 page two). Every action finds the
 * entry through the NOD_QUEUE cookie — there is no account yet — and refuses
 * quietly when it is missing, which the page turns into "email me my link".
 */

export type QueueActionResult = { ok: true; devCode?: string } | { ok: false; error: string }

async function currentEntry() {
  const id = await readQueueCookie()
  if (!id) return null
  return prisma.waitlistEntry.findFirst({ where: { id, deletedAt: null } })
}

/** No cookie: mail the signed link to whoever owns the address. Always says "sent". */
export async function requestQueueLink(rawEmail: unknown): Promise<QueueActionResult> {
  const head = await headers()
  const ip = head.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!(await rateLimit(`queue-link:${ip}`, 5, 15 * 60_000))) return { ok: false, error: 'rateLimited' }
  const email = normaliseEmail(String(rawEmail ?? ''))
  if (!email) return { ok: false, error: 'email' }
  const entry = await prisma.waitlistEntry.findFirst({ where: { email, deletedAt: null }, select: { id: true } })
  // Whether or not the address is on the list, the answer is the same — no enumeration.
  if (entry) await sendQueueLink({ email, queueUrl: queueLink(entry.id, 'email') })
  return { ok: true }
}

export async function startPhoneVerification(rawPhone: unknown): Promise<QueueActionResult> {
  const entry = await currentEntry()
  if (!entry) return { ok: false, error: 'noSession' }
  const phone = normalisePhone(String(rawPhone ?? ''))
  if (!phone) return { ok: false, error: 'phone' }
  const result = await requestPhoneCode(entry, phone)
  if (!result.ok) return result
  return { ok: true, devCode: result.devCode }
}

export async function confirmPhone(rawPhone: unknown, rawCode: unknown): Promise<QueueActionResult> {
  const entry = await currentEntry()
  if (!entry) return { ok: false, error: 'noSession' }
  const phone = normalisePhone(String(rawPhone ?? ''))
  if (!phone) return { ok: false, error: 'phone' }
  const result = await verifyPhoneCode(phone, String(rawCode ?? ''))
  if (!result.ok) return result
  await markPhoneVerified(entry.id, phone)
  return { ok: true }
}

const AGE_BRACKETS = ['18-20', '21-25', '26-30', '31+'] as const
const FOLLOWER_BRACKETS = ['lt300', '300-1k', '1k-5k', '5k-20k', '20k+'] as const
const CATEGORIES = ['gym', 'food', 'study', 'travel', 'fashion', 'gaming', 'nightlife', 'hobby', 'other'] as const

const profileSchema = z.object({
  displayName: z.string().trim().max(40).optional(),
  handle: z
    .string()
    .trim()
    .max(80)
    .transform((v) => v.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\/@?/i, '').replace(/\/.*$/, ''))
    .optional(),
  ageBracket: z.enum(AGE_BRACKETS).optional(),
  followersBracket: z.enum(FOLLOWER_BRACKETS).optional(),
  categories: z.array(z.enum(CATEGORIES)).max(9).optional(),
})

export async function saveQueueProfile(input: unknown): Promise<QueueActionResult> {
  const entry = await currentEntry()
  if (!entry) return { ok: false, error: 'noSession' }
  const parsed = profileSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'invalid' }
  const data = parsed.data
  await updateProfile(entry.id, {
    displayName: data.displayName === undefined ? undefined : data.displayName || null,
    handle: data.handle === undefined ? undefined : data.handle || null,
    ageBracket: data.ageBracket,
    followersBracket: data.followersBracket,
    categories: data.categories,
  })
  return { ok: true }
}

/** The SMS switch on the page — consent on, or off again. Off is also what STOP does. */
export async function setSmsPreference(enabled: unknown): Promise<QueueActionResult> {
  const entry = await currentEntry()
  if (!entry) return { ok: false, error: 'noSession' }
  if (!entry.phone) return { ok: false, error: 'phone' }
  const now = new Date()
  await prisma.waitlistEntry.update({
    where: { id: entry.id },
    data: enabled === true ? { smsConsentAt: now, smsOptOutAt: null } : { smsOptOutAt: now },
  })
  return { ok: true }
}

/**
 * Leave: the entry is soft-deleted (CLAUDE.md rule 9) and drops out of every count.
 * Referrals it earned for someone else stay — they were real when they were earned.
 */
export async function leaveQueue(): Promise<QueueActionResult> {
  const entry = await currentEntry()
  if (!entry) return { ok: false, error: 'noSession' }
  await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { deletedAt: new Date() } })
  await clearQueueCookie()
  return { ok: true }
}
