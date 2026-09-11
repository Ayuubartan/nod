'use server'

import { cookies, headers } from 'next/headers'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { emit } from '@/lib/events'
import { rateLimit } from '@/lib/rate-limit'
import { sendWaitlistConfirmation, sendQueueLink, sendBrandEnquiryToOps } from '@/lib/email'
import { getLocale } from 'next-intl/server'
import type { Locale } from '@/lib/i18n/config'
import { CITIES, joinQueue, normalisePhone } from '@/lib/queue'
import { queueLink, setQueueCookie } from '@/lib/queue-session'
import { REF_COOKIE } from '@/lib/referral-cookie'

/**
 * Marketing form actions — docs/01 section 7, docs/13 (the waitlist game).
 *
 * Both actions validate with zod, rate-limit by IP, and never trust a client-supplied
 * referral code beyond looking it up.
 */

const waitlistSchema = z.object({
  city: z.enum(CITIES, { message: 'city' }),
  phone: z
    .string()
    .trim()
    .max(32)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  email: z.string().trim().toLowerCase().email('email').max(254, 'email'),
  referredBy: z.string().trim().max(32).optional().nullable(),
  consent: z.literal(true, { message: 'consent' }),
  smsConsent: z.boolean().optional().default(false),
  marketingConsent: z.boolean().optional().default(false),
  source: z.string().trim().max(64).optional().nullable(),
  utmSource: z.string().trim().max(64).optional().nullable(),
  utmMedium: z.string().trim().max(64).optional().nullable(),
  utmCampaign: z.string().trim().max(64).optional().nullable(),
})

export type WaitlistResult =
  | { ok: true; position: number; referralCode: string; shareUrl: string }
  | { ok: false; error: string }

/**
 * Page one of the game: the least we can ask. The reply sets the NOD_QUEUE cookie so
 * the client can go straight to /queue, and the confirmation mail carries the link
 * that proves the address. Someone who is already in gets their link mailed instead
 * of an error they cannot act on.
 */
export async function joinWaitlist(input: unknown): Promise<WaitlistResult> {
  const head = await headers()
  const ip = head.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  if (!(await rateLimit(`waitlist:${ip}`, 5, 60_000))) {
    return { ok: false, error: 'rateLimited' }
  }

  const parsed = waitlistSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'error' }
  }
  const data = parsed.data

  let phone: string | null = null
  if (data.phone) {
    phone = normalisePhone(data.phone)
    if (!phone) return { ok: false, error: 'phone' }
  }

  // A shared link may have set the referral cookie before the form was ever seen.
  const store = await cookies()
  const referredBy = data.referredBy || store.get(REF_COOKIE)?.value || null

  const result = await joinQueue({
    email: data.email,
    phone,
    city: data.city,
    referredBy,
    smsConsent: data.smsConsent,
    marketingConsent: data.marketingConsent,
    signupSource: data.source ?? null,
    utmSource: data.utmSource ?? null,
    utmMedium: data.utmMedium ?? null,
    utmCampaign: data.utmCampaign ?? null,
    ip,
  })

  if (!result.ok) {
    if (result.error === 'duplicate') {
      const existing = await prisma.waitlistEntry.findFirst({
        where: { email: data.email, deletedAt: null },
        select: { id: true },
      })
      if (existing) await sendQueueLink({ email: data.email, queueUrl: queueLink(existing.id, 'email') })
    }
    return { ok: false, error: result.error }
  }

  const { entry } = result
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const shareUrl = `${siteUrl}/r/${entry.referralCode}`

  await setQueueCookie(entry.id)
  // In the language they signed up in — an English visitor was getting Swedish mail.
  await sendWaitlistConfirmation({
    email: entry.email,
    position: entry.position,
    queueUrl: queueLink(entry.id, 'email'),
    shareUrl,
    locale: (await getLocale()) as Locale,
  })
  await emit({
    name: 'waitlist/joined',
    data: { entryId: entry.id, position: entry.position, referredBy: entry.referredBy },
    id: `waitlist:${entry.id}`,
  })

  return { ok: true, position: entry.position, referralCode: entry.referralCode, shareUrl }
}

// ---------------------------------------------------------------- brand enquiry

const enquirySchema = z.object({
  company: z.string().trim().min(1, 'company').max(120),
  name: z.string().trim().min(1, 'name').max(120),
  email: z.string().trim().toLowerCase().email('email'),
  budgetBracket: z.enum(['10-25k', '25-100k', '100k+'], { message: 'budgetBracket' }),
  objective: z.string().trim().max(200).optional().nullable(),
  message: z.string().trim().max(2000).optional().nullable(),
})

export type EnquiryResult = { ok: true } | { ok: false; error: string }

export async function submitBrandEnquiry(input: unknown): Promise<EnquiryResult> {
  const head = await headers()
  const ip = head.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!(await rateLimit(`enquiry:${ip}`, 5, 60_000))) return { ok: false, error: 'rateLimited' }

  const parsed = enquirySchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'error' }

  const enquiry = await prisma.brandEnquiry.create({
    data: {
      company: parsed.data.company,
      name: parsed.data.name,
      email: parsed.data.email,
      budgetBracket: parsed.data.budgetBracket,
      objective: parsed.data.objective ?? null,
      message: parsed.data.message ?? null,
    },
  })

  await sendBrandEnquiryToOps(enquiry)
  await emit({ name: 'brand/enquiry', data: { enquiryId: enquiry.id }, id: `enquiry:${enquiry.id}` })

  return { ok: true }
}
