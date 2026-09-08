/**
 * The waitlist as a game — docs/13.
 *
 * Joining takes a city, a mobile number and an email. Everything after that is
 * earned: points for proving you are real (phone, email), for telling us more, and
 * above all for friends who join through your link and get verified themselves.
 * Rank is derived from points, never stored, and never invented — every number a
 * person sees on /queue comes from rows in this file's two tables:
 *
 *   WaitlistPoint  append-only ledger of points, one row per reason (unique per ref so
 *                  a retried request cannot double-award). `WaitlistEntry.points` is
 *                  the cached sum, updated in the same transaction.
 *   WaitlistEvent  what happened to whom — the feed on /queue and the source of every
 *                  SMS and email. `notifiedAt` is set once the digest has told them.
 *
 * Levels come from verified referrals alone. Reaching one is worth a bonus and, at
 * Insider, priority access when ops opens the doors (grantAccess).
 *
 * Pure rules live at the top and are unit-tested; the database half follows.
 */

import { createHmac } from 'node:crypto'
import type { Prisma, WaitlistEntry, WaitlistEventType } from '@prisma/client'
import { prisma } from './db'
import { referralCode } from './crypto'
import { flag } from './flags'

// ---------------------------------------------------------------- rules

export const POINTS = {
  phoneVerified: 100,
  profileCompleted: 100,
  interests: 50,
  /** Per verified referral, times `waitlist.boostMultiplier`. */
  referral: 250,
  dailyBoost: 500,
} as const

export type LevelKey = 'queue' | 'connector' | 'social' | 'insider' | 'founding'

export type Level = {
  level: number
  key: LevelKey
  /** Verified referrals needed. */
  referrals: number
  /** One-off points on reaching it. */
  bonus: number
  /** Insider and up are first in line when access opens. */
  priority: boolean
}

export const LEVELS: readonly Level[] = [
  { level: 0, key: 'queue', referrals: 0, bonus: 0, priority: false },
  { level: 1, key: 'connector', referrals: 1, bonus: 0, priority: false },
  { level: 2, key: 'social', referrals: 3, bonus: 250, priority: false },
  { level: 3, key: 'insider', referrals: 5, bonus: 500, priority: true },
  { level: 4, key: 'founding', referrals: 10, bonus: 1000, priority: true },
]

/** The highest level these verified referrals have earned. */
export function levelFor(verifiedReferrals: number): Level {
  let current = LEVELS[0]!
  for (const level of LEVELS) if (verifiedReferrals >= level.referrals) current = level
  return current
}

/** The next level and how many more verified friends it takes; null at the top. */
export function nextLevel(verifiedReferrals: number): { level: Level; remaining: number } | null {
  const level = LEVELS.find((l) => l.referrals > verifiedReferrals)
  return level ? { level, remaining: level.referrals - verifiedReferrals } : null
}

/**
 * Swedish mobile numbers only, stored as +467xxxxxxxx. Accepts 07x…, +467x…, 00467x…
 * and 467x… with any spacing or dashes. Anything else — a landline, a foreign number,
 * a typo — is null; the pilot is Swedish (docs/01).
 */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '').replace(/^00/, '+')
  let national: string
  if (digits.startsWith('+46')) national = digits.slice(3)
  else if (digits.startsWith('46') && digits.length === 11) national = digits.slice(2)
  else if (digits.startsWith('0')) national = digits.slice(1)
  else return null
  if (!/^7[0-9]{8}$/.test(national)) return null
  return `+46${national}`
}

/** Rank percentile, rounded up so the number shown is never better than the truth. */
export function percentile(rank: number, total: number): number {
  if (total <= 0) return 100
  return Math.min(100, Math.max(1, Math.ceil((rank / total) * 100)))
}

/** Ten blocks of progress — the spec's own picture of it. */
export function progressBar(done: number, needed: number, width = 10): string {
  const filled = needed <= 0 ? width : Math.min(width, Math.round((done / needed) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Keyed hash of an IP: enough to spot a burst from one address, useless to reverse. */
export function hashIp(ip: string): string {
  const key = process.env.ENCRYPTION_KEY ?? 'nod-dev-only'
  return createHmac('sha256', key).update(`ip:${ip}`).digest('hex').slice(0, 32)
}

export const ACCESS_TTL_MS = 48 * 60 * 60 * 1000
/** More verified referrals than this from one address and the rest stop counting. */
export const MAX_REFERRALS_PER_IP = 5

/**
 * Whether a freshly verified entry should count for the person who referred it.
 * Self-referrals (same email, phone or address as the referrer) and bursts from one
 * address never do. The friend still joins and still has their own place — only the
 * reward is withheld, so there is nothing to be gained by arguing about it.
 */
export function referralCounts(args: {
  referrer: Pick<WaitlistEntry, 'email' | 'phone' | 'ipHash'>
  entry: Pick<WaitlistEntry, 'email' | 'phone' | 'ipHash'>
  /** Verified referrals of this referrer that already share the entry's ipHash. */
  sameIpVerified: number
}): boolean {
  const { referrer, entry } = args
  if (referrer.email.toLowerCase() === entry.email.toLowerCase()) return false
  if (referrer.phone && entry.phone && referrer.phone === entry.phone) return false
  if (referrer.ipHash && entry.ipHash && referrer.ipHash === entry.ipHash) return false
  if (entry.ipHash && args.sameIpVerified >= MAX_REFERRALS_PER_IP) return false
  return true
}

// ---------------------------------------------------------------- database

type Tx = Prisma.TransactionClient

export const CITIES = ['stockholm', 'goteborg', 'malmo', 'uppsala', 'other'] as const
export type City = (typeof CITIES)[number]

export type Rank = { rank: number; total: number; percentile: number }

/** 1 + everyone ahead: more points, or the same points and an earlier signup. */
export async function rankOf(entry: Pick<WaitlistEntry, 'points' | 'createdAt'>, city?: string): Promise<Rank> {
  const scope: Prisma.WaitlistEntryWhereInput = city ? { city, deletedAt: null } : { deletedAt: null }
  const [ahead, total] = await Promise.all([
    prisma.waitlistEntry.count({
      where: {
        ...scope,
        OR: [{ points: { gt: entry.points } }, { points: entry.points, createdAt: { lt: entry.createdAt } }],
      },
    }),
    prisma.waitlistEntry.count({ where: scope }),
  ])
  const rank = ahead + 1
  return { rank, total, percentile: percentile(rank, total) }
}

export async function recordEvent(
  tx: Tx,
  entryId: string,
  type: WaitlistEventType,
  data?: Record<string, unknown>,
): Promise<void> {
  await tx.waitlistEvent.create({
    data: { entryId, type, data: (data ?? undefined) as Prisma.InputJsonValue | undefined },
  })
}

/**
 * Awards points once per (reason, ref). Returns false when that award already
 * existed, so a double-submitted form or a re-delivered webhook is harmless.
 */
export async function awardPoints(tx: Tx, entryId: string, amount: number, reason: string, refId = ''): Promise<boolean> {
  const existing = await tx.waitlistPoint.findUnique({ where: { entryId_reason_refId: { entryId, reason, refId } } })
  if (existing) return false
  await tx.waitlistPoint.create({ data: { entryId, amount, reason, refId } })
  await tx.waitlistEntry.update({ where: { id: entryId }, data: { points: { increment: amount } } })
  return true
}

export async function uniqueReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = referralCode()
    const clash = await prisma.waitlistEntry.findUnique({ where: { referralCode: code }, select: { id: true } })
    if (!clash) return code
  }
  throw new Error('Could not allocate a unique referral code')
}

export type JoinInput = {
  email: string
  phone: string | null
  city: City
  referredBy: string | null
  smsConsent: boolean
  marketingConsent: boolean
  signupSource: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  ip: string
}

export type JoinResult = { ok: true; entry: WaitlistEntry } | { ok: false; error: 'duplicate' | 'phoneTaken' }

/**
 * Creates the entry. Position is join order and never changes; rank is what moves.
 * The referrer hears that a friend joined (an event, no points yet — points come at
 * verification, see markVerified).
 */
export async function joinQueue(input: JoinInput): Promise<JoinResult> {
  const email = input.email.trim().toLowerCase()
  const existing = await prisma.waitlistEntry.findFirst({ where: { email, deletedAt: null } })
  if (existing) return { ok: false, error: 'duplicate' }

  if (input.phone) {
    const taken = await prisma.waitlistEntry.findFirst({
      where: { phone: input.phone, deletedAt: null },
      select: { id: true },
    })
    if (taken) return { ok: false, error: 'phoneTaken' }
  }

  let referredBy: string | null = null
  if (input.referredBy) {
    const referrer = await prisma.waitlistEntry.findUnique({
      where: { referralCode: input.referredBy.toUpperCase() },
      select: { referralCode: true, email: true, deletedAt: true },
    })
    // A link to yourself is just a link.
    if (referrer && !referrer.deletedAt && referrer.email !== email) referredBy = referrer.referralCode
  }

  const code = await uniqueReferralCode()
  const now = new Date()

  const entry = await prisma.$transaction(async (tx) => {
    const position = (await tx.waitlistEntry.count({ where: { deletedAt: null } })) + 1
    const created = await tx.waitlistEntry.create({
      data: {
        email,
        phone: input.phone,
        city: input.city,
        referralCode: code,
        referredBy,
        position,
        consentAt: now,
        smsConsentAt: input.smsConsent && input.phone ? now : null,
        marketingConsentAt: input.marketingConsent ? now : null,
        signupSource: input.signupSource,
        utmSource: input.utmSource,
        utmMedium: input.utmMedium,
        utmCampaign: input.utmCampaign,
        ipHash: hashIp(input.ip),
        lastActiveAt: now,
      },
    })
    await recordEvent(tx, created.id, 'SIGNED_UP', { position, referredBy })
    if (referredBy) {
      const referrer = await tx.waitlistEntry.findUnique({ where: { referralCode: referredBy }, select: { id: true } })
      if (referrer) await recordEvent(tx, referrer.id, 'FRIEND_JOINED', { entryId: created.id })
    }
    return created
  })

  return { ok: true, entry }
}

/** Opening the link in the confirmation mail proves the address. */
export async function markEmailVerified(entryId: string): Promise<WaitlistEntry | null> {
  const entry = await prisma.waitlistEntry.findFirst({ where: { id: entryId, deletedAt: null } })
  if (!entry) return null
  if (entry.emailVerifiedAt) return entry
  const now = new Date()
  return prisma.$transaction(async (tx) => {
    await tx.waitlistEntry.update({ where: { id: entryId }, data: { emailVerifiedAt: now, lastActiveAt: now } })
    await recordEvent(tx, entryId, 'EMAIL_VERIFIED')
    return markVerified(tx, entryId)
  })
}

/** A correct SMS code proves the number and is worth points of its own. */
export async function markPhoneVerified(entryId: string, phone: string): Promise<WaitlistEntry | null> {
  const entry = await prisma.waitlistEntry.findFirst({ where: { id: entryId, deletedAt: null } })
  if (!entry) return null
  const now = new Date()
  return prisma.$transaction(async (tx) => {
    await tx.waitlistEntry.update({ where: { id: entryId }, data: { phone, phoneVerifiedAt: now, lastActiveAt: now } })
    if (await awardPoints(tx, entryId, POINTS.phoneVerified, 'phone_verified')) {
      await recordEvent(tx, entryId, 'PHONE_VERIFIED', { points: POINTS.phoneVerified })
    }
    return markVerified(tx, entryId)
  })
}

/**
 * The moment an entry counts as a real person — first verification of either kind.
 * This is where the referrer gets paid: points, a verified referral, maybe a level.
 * Idempotent: a second call finds `verifiedAt` set and does nothing.
 */
async function markVerified(tx: Tx, entryId: string): Promise<WaitlistEntry> {
  const entry = await tx.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } })
  if (entry.verifiedAt) return entry
  const now = new Date()
  const verified = await tx.waitlistEntry.update({ where: { id: entryId }, data: { verifiedAt: now } })

  if (!entry.referredBy) return verified
  const referrer = await tx.waitlistEntry.findUnique({ where: { referralCode: entry.referredBy } })
  if (!referrer || referrer.deletedAt) return verified

  const sameIpVerified = entry.ipHash
    ? await tx.waitlistEntry.count({
        where: {
          referredBy: referrer.referralCode,
          ipHash: entry.ipHash,
          verifiedAt: { not: null },
          id: { not: entryId },
        },
      })
    : 0
  if (!referralCounts({ referrer, entry, sameIpVerified })) {
    await recordEvent(tx, referrer.id, 'FRIEND_VERIFIED', { entryId, counted: false })
    return verified
  }

  const multiplier = Math.max(1, Math.round(await flag('waitlist.boostMultiplier')))
  const amount = POINTS.referral * multiplier
  if (!(await awardPoints(tx, referrer.id, amount, 'referral', entryId))) return verified

  const before = levelFor(referrer.verifiedReferrals)
  const count = referrer.verifiedReferrals + 1
  const after = levelFor(count)
  await tx.waitlistEntry.update({ where: { id: referrer.id }, data: { verifiedReferrals: count, level: after.level } })
  await recordEvent(tx, referrer.id, 'FRIEND_VERIFIED', { entryId, points: amount, counted: true, verifiedReferrals: count })

  if (after.level > before.level) {
    if (after.bonus > 0) await awardPoints(tx, referrer.id, after.bonus, 'level', after.key)
    if (after.priority && !referrer.priorityAt) {
      await tx.waitlistEntry.update({ where: { id: referrer.id }, data: { priorityAt: now } })
    }
    await recordEvent(tx, referrer.id, 'LEVEL_UNLOCKED', {
      level: after.level,
      key: after.key,
      bonus: after.bonus,
      priority: after.priority,
    })
  }
  return verified
}

export type ProfileInput = {
  displayName?: string | null
  handle?: string | null
  ageBracket?: string | null
  followersBracket?: string | null
  categories?: string[]
}

/** Optional details, each worth points the first time they are filled in. */
export async function updateProfile(entryId: string, input: ProfileInput): Promise<WaitlistEntry> {
  return prisma.$transaction(async (tx) => {
    const data: Prisma.WaitlistEntryUpdateInput = { lastActiveAt: new Date() }
    if (input.displayName !== undefined) data.displayName = input.displayName
    if (input.handle !== undefined) data.handle = input.handle
    if (input.ageBracket !== undefined) data.ageBracket = input.ageBracket
    if (input.followersBracket !== undefined) data.followersBracket = input.followersBracket
    if (input.categories !== undefined) data.categories = input.categories
    const entry = await tx.waitlistEntry.update({ where: { id: entryId }, data })

    if (entry.ageBracket && entry.followersBracket && entry.handle) {
      if (await awardPoints(tx, entryId, POINTS.profileCompleted, 'profile')) {
        await recordEvent(tx, entryId, 'PROFILE_COMPLETED', { points: POINTS.profileCompleted, what: 'profile' })
      }
    }
    if (entry.categories.length > 0) {
      if (await awardPoints(tx, entryId, POINTS.interests, 'interests')) {
        await recordEvent(tx, entryId, 'PROFILE_COMPLETED', { points: POINTS.interests, what: 'interests' })
      }
    }
    return tx.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } })
  })
}

/** Monday 00:00 Europe/Stockholm of the current week — the leaderboard resets then. */
export function weekStart(now = new Date()): Date {
  const wall = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Stockholm' }))
  const offset = wall.getTime() - now.getTime()
  const day = (wall.getDay() + 6) % 7
  wall.setDate(wall.getDate() - day)
  wall.setHours(0, 0, 0, 0)
  // Back to a real instant: the offset between the two wall clocks is the zone offset.
  return new Date(wall.getTime() - offset)
}

export type LeaderboardRow = { entryId: string; name: string; points: number; level: number }

/** Points earned this week, per city. Names are what people chose to show, or nothing. */
export async function weeklyLeaderboard(city: string, take = 10, now = new Date()): Promise<LeaderboardRow[]> {
  const grouped = await prisma.waitlistPoint.groupBy({
    by: ['entryId'],
    where: { createdAt: { gte: weekStart(now) }, entry: { city, deletedAt: null } },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take,
  })
  if (grouped.length === 0) return []
  const entries = await prisma.waitlistEntry.findMany({
    where: { id: { in: grouped.map((g) => g.entryId) } },
    select: { id: true, displayName: true, handle: true, level: true },
  })
  const byId = new Map(entries.map((e) => [e.id, e]))
  return grouped.map((g) => {
    const entry = byId.get(g.entryId)
    return {
      entryId: g.entryId,
      name: entry?.displayName || (entry?.handle ? `@${entry.handle}` : ''),
      points: g._sum.amount ?? 0,
      level: entry?.level ?? 0,
    }
  })
}

/** Points this entry earned since Monday, and where that puts them in their city this week. */
export async function weeklyStanding(
  entry: Pick<WaitlistEntry, 'id' | 'city'>,
  now = new Date(),
): Promise<{ points: number; rank: number | null }> {
  const since = weekStart(now)
  const mine = await prisma.waitlistPoint.aggregate({
    where: { entryId: entry.id, createdAt: { gte: since } },
    _sum: { amount: true },
  })
  const points = mine._sum.amount ?? 0
  if (points === 0) return { points, rank: null }
  const grouped = await prisma.waitlistPoint.groupBy({
    by: ['entryId'],
    where: { createdAt: { gte: since }, entry: { city: entry.city, deletedAt: null } },
    _sum: { amount: true },
    having: { amount: { _sum: { gt: points } } },
  })
  return { points, rank: grouped.length + 1 }
}

/**
 * Ops opens the doors to the next N: priority first, then points, then join order.
 * Each gets 48 hours to sign in (docs/13 "DIN TUR"). Returns the entries so the
 * caller can tell them.
 *
 * DECISION: the 48h window is a timestamp compared at sign-in, not a state with a
 * timeout job (CLAUDE.md rule 4 is about money-bearing states). An expired grant is
 * simply not access; ops can grant again.
 */
export async function grantAccess(count: number): Promise<WaitlistEntry[]> {
  const candidates = await prisma.waitlistEntry.findMany({
    where: { deletedAt: null, accessGrantedAt: null, convertedUserId: null, verifiedAt: { not: null } },
    orderBy: [{ priorityAt: { sort: 'desc', nulls: 'last' } }, { points: 'desc' }, { createdAt: 'asc' }],
    take: Math.max(0, Math.min(count, 1000)),
  })
  const now = new Date()
  const expires = new Date(now.getTime() + ACCESS_TTL_MS)
  return prisma.$transaction(async (tx) => {
    const granted: WaitlistEntry[] = []
    for (const entry of candidates) {
      granted.push(
        await tx.waitlistEntry.update({
          where: { id: entry.id },
          data: { accessGrantedAt: now, accessExpiresAt: expires },
        }),
      )
      await recordEvent(tx, entry.id, 'ACCESS_GRANTED', { expiresAt: expires.toISOString() })
    }
    return granted
  })
}

/** Whether this address may create an account while the gate is up. */
export async function hasAccess(email: string, now = new Date()): Promise<boolean> {
  const entry = await prisma.waitlistEntry.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null, accessGrantedAt: { not: null } },
    select: { accessExpiresAt: true, convertedUserId: true },
    orderBy: { createdAt: 'desc' },
  })
  if (!entry) return false
  if (entry.convertedUserId) return true
  return !entry.accessExpiresAt || entry.accessExpiresAt > now
}

/** The waitlist entry becomes an account: remembered, and the event closes the loop. */
export async function markConverted(email: string, userId: string): Promise<void> {
  const entry = await prisma.waitlistEntry.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null, convertedUserId: null },
    select: { id: true },
  })
  if (!entry) return
  await prisma.$transaction(async (tx) => {
    await tx.waitlistEntry.update({ where: { id: entry.id }, data: { convertedUserId: userId } })
    await recordEvent(tx, entry.id, 'ACCESS_USED', { userId })
  })
}

/**
 * The surprise: `waitlist.dailyBoostCount` verified people, drawn at random, get
 * +500 today. Zero (the default) means no draw. Idempotent per day via the ledger ref.
 */
export async function dailyBoost(now = new Date()): Promise<number> {
  const count = Math.max(0, Math.round(await flag('waitlist.dailyBoostCount')))
  if (count === 0) return 0
  const day = now.toISOString().slice(0, 10)
  const total = await prisma.waitlistEntry.count({ where: { deletedAt: null, verifiedAt: { not: null } } })
  if (total === 0) return 0
  // A random sample without loading every row: random offsets, deduped.
  const offsets = new Set<number>()
  while (offsets.size < Math.min(count, total)) offsets.add(Math.floor(Math.random() * total))
  let boosted = 0
  for (const skip of offsets) {
    const entry = await prisma.waitlistEntry.findFirst({
      where: { deletedAt: null, verifiedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
      skip,
      select: { id: true },
    })
    if (!entry) continue
    await prisma.$transaction(async (tx) => {
      if (await awardPoints(tx, entry.id, POINTS.dailyBoost, 'daily_boost', day)) {
        await recordEvent(tx, entry.id, 'REWARD_UNLOCKED', { reward: 'daily_boost', points: POINTS.dailyBoost })
        boosted++
      }
    })
  }
  return boosted
}
