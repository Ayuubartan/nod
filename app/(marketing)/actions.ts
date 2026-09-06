'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { referralCode } from '@/lib/crypto'
import { emit } from '@/lib/events'
import { rateLimit } from '@/lib/rate-limit'
import { sendWaitlistConfirmation, sendBrandEnquiryToOps } from '@/lib/email'

/**
 * Marketing form actions — docs/01 sections 7 and /brands.
 *
 * Both actions validate with zod, rate-limit by IP, and never trust a client-supplied
 * referral code beyond looking it up.
 */

const CITIES = ['stockholm', 'goteborg', 'malmo', 'uppsala', 'other'] as const
// 18 is the floor everywhere in NOD — there is no under-18 option, by design (docs/07 section 6).
const AGE_BRACKETS = ['18-20', '21-25', '26-30', '31+'] as const
const FOLLOWER_BRACKETS = ['lt300', '300-1k', '1k-5k', '5k-20k', '20k+'] as const
const CATEGORIES = ['gym', 'food', 'study', 'travel', 'fashion', 'gaming', 'nightlife', 'hobby', 'other'] as const

const waitlistSchema = z.object({
  handle: z
    .string()
    .trim()
    .min(2, 'handle')
    .max(80, 'handle')
    .transform((v) => v.replace(/^@/, '').trim()),
  city: z.enum(CITIES, { message: 'city' }),
  ageBracket: z.enum(AGE_BRACKETS, { message: 'ageBracket' }),
  followersBracket: z.enum(FOLLOWER_BRACKETS, { message: 'followersBracket' }),
  categories: z.array(z.enum(CATEGORIES)).min(1, 'categories'),
  email: z.string().trim().toLowerCase().email('email'),
  referredBy: z.string().trim().max(32).optional().nullable(),
  consent: z.literal(true, { message: 'consent' }),
})

export type WaitlistResult =
  | { ok: true; position: number; referralCode: string; shareUrl: string }
  | { ok: false; error: string }

/**
 * A handle can arrive as "@name", "name", or a full profile URL. TikTok URLs and
 * handles are recognisable; anything else is treated as Instagram (docs/01: "auto-detect
 * platform from @ or URL").
 */
function detectPlatform(raw: string): 'INSTAGRAM' | 'TIKTOK' {
  const value = raw.toLowerCase()
  if (value.includes('tiktok.com') || value.startsWith('tt:')) return 'TIKTOK'
  return 'INSTAGRAM'
}

function normaliseHandle(raw: string): string {
  const urlMatch = raw.match(/(?:instagram\.com|tiktok\.com)\/@?([A-Za-z0-9._-]+)/i)
  if (urlMatch?.[1]) return urlMatch[1]
  return raw.replace(/^@/, '')
}

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

  const existing = await prisma.waitlistEntry.findFirst({
    where: { email: data.email, deletedAt: null },
    select: { id: true },
  })
  if (existing) return { ok: false, error: 'duplicate' }

  // Only attribute to a referral code that actually exists.
  let referredBy: string | null = null
  if (data.referredBy) {
    const referrer = await prisma.waitlistEntry.findUnique({
      where: { referralCode: data.referredBy.toUpperCase() },
      select: { referralCode: true },
    })
    referredBy = referrer?.referralCode ?? null
  }

  const code = await uniqueReferralCode()
  const position = (await prisma.waitlistEntry.count({ where: { deletedAt: null } })) + 1

  const entry = await prisma.waitlistEntry.create({
    data: {
      handle: normaliseHandle(data.handle),
      platform: detectPlatform(data.handle),
      city: data.city,
      ageBracket: data.ageBracket,
      followersBracket: data.followersBracket,
      categories: data.categories,
      email: data.email,
      referralCode: code,
      referredBy,
      consentAt: new Date(),
      position,
    },
  })

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const shareUrl = `${siteUrl}/?ref=${code}`

  await sendWaitlistConfirmation({ email: data.email, position, shareUrl, handle: entry.handle })
  await emit({ name: 'waitlist/joined', data: { entryId: entry.id, position, referredBy }, id: `waitlist:${entry.id}` })

  return { ok: true, position, referralCode: code, shareUrl }
}

async function uniqueReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = referralCode()
    const clash = await prisma.waitlistEntry.findUnique({ where: { referralCode: code }, select: { id: true } })
    if (!clash) return code
  }
  throw new Error('Could not allocate a unique referral code')
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
