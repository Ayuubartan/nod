/**
 * The waitlist game against the database (docs/13).
 *
 *   - joining gives a position and a rank, a second join of the same address does not
 *   - a referral pays only when the friend verifies, and moves the referrer's level
 *   - self-referrals and bursts from one address do not pay
 *   - points never double-award, however often the same thing happens
 *   - access is granted in the right order, expires, and gates sign-in
 *   - the digest sends one text per person, only with consent, and STOP ends it
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, resetDb } from './helpers/db'
import { clearSentMail, sentMail } from '@/lib/email'
import { setFlag } from '@/lib/flags'
import { FakeSmsProvider, setSmsProvider } from '@/lib/integrations/sms'
import { resolveIdentity } from '@/lib/login'
import {
  ACCESS_TTL_MS,
  LEVELS,
  MAX_REFERRALS_PER_IP,
  POINTS,
  awardPoints,
  dailyBoost,
  grantAccess,
  hasAccess,
  joinQueue,
  markConverted,
  markEmailVerified,
  markPhoneVerified,
  rankOf,
  updateProfile,
  weeklyLeaderboard,
  weeklyStanding,
  type JoinInput,
} from '@/lib/queue'
import { announceAccess, handleInboundSms, requestPhoneCode, runDigest, verifyPhoneCode } from '@/lib/waitlist-sms'

const fakeSms = new FakeSmsProvider()

beforeEach(async () => {
  await resetDb()
  fakeSms.reset()
  setSmsProvider(fakeSms)
})

afterAll(async () => {
  setSmsProvider(null)
  await db.$disconnect()
})

let n = 0
function input(overrides: Partial<JoinInput> = {}): JoinInput {
  n++
  return {
    email: `person${n}@example.se`,
    phone: null,
    city: 'stockholm',
    referredBy: null,
    smsConsent: false,
    marketingConsent: false,
    signupSource: 'test',
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    ip: `10.0.0.${n}`,
    ...overrides,
  }
}

async function join(overrides: Partial<JoinInput> = {}) {
  const result = await joinQueue(input(overrides))
  if (!result.ok) throw new Error(result.error)
  return result.entry
}

const reload = (id: string) => db.waitlistEntry.findUniqueOrThrow({ where: { id } })
const events = (id: string) => db.waitlistEvent.findMany({ where: { entryId: id }, orderBy: { createdAt: 'asc' } })

// A daytime instant, so quiet hours never get in the way of a digest test.
const NOON = new Date('2026-06-15T12:00:00+02:00')

describe('joining', () => {
  it('gives a position in join order and a rank among everyone', async () => {
    const a = await join()
    const b = await join()
    expect(a.position).toBe(1)
    expect(b.position).toBe(2)
    expect(a.referralCode).toMatch(/^[A-Z0-9]{6,}$/)
    expect(a.referralCode).not.toBe(b.referralCode)
    expect(await rankOf(a)).toEqual({ rank: 1, total: 2, percentile: 50 })
    expect(await rankOf(b)).toEqual({ rank: 2, total: 2, percentile: 100 })
    expect((await events(a.id)).map((e) => e.type)).toEqual(['SIGNED_UP'])
  })

  it('refuses the same address twice and the same phone twice', async () => {
    await join({ email: 'anna@example.se', phone: '+46701234567' })
    expect(await joinQueue(input({ email: 'Anna@Example.se' }))).toEqual({ ok: false, error: 'duplicate' })
    expect(await joinQueue(input({ phone: '+46701234567' }))).toEqual({ ok: false, error: 'phoneTaken' })
    expect(await db.waitlistEntry.count()).toBe(1)
  })

  it('records SMS consent only when there is a number to consent for', async () => {
    const without = await join({ smsConsent: true })
    const withPhone = await join({ smsConsent: true, phone: '+46701234568' })
    expect(without.smsConsentAt).toBeNull()
    expect(withPhone.smsConsentAt).not.toBeNull()
    expect(withPhone.consentAt).not.toBeNull()
    expect(withPhone.marketingConsentAt).toBeNull()
  })

  it('attributes a referral and tells the referrer a friend joined — no points yet', async () => {
    const anna = await join()
    const friend = await join({ referredBy: anna.referralCode.toLowerCase() })
    expect(friend.referredBy).toBe(anna.referralCode)
    expect((await reload(anna.id)).points).toBe(0)
    expect((await events(anna.id)).map((e) => e.type)).toEqual(['SIGNED_UP', 'FRIEND_JOINED'])
  })

  it('ignores the code of someone who left, and unknown codes', async () => {
    const anna = await join({ email: 'anna@example.se' })
    await db.waitlistEntry.update({ where: { id: anna.id }, data: { deletedAt: new Date() } })
    const back = await join({ email: 'anna@example.se', referredBy: anna.referralCode })
    expect(back.referredBy).toBeNull()
    const nobody = await join({ referredBy: 'NOPE99' })
    expect(nobody.referredBy).toBeNull()
  })
})

describe('verification and referral credit', () => {
  it('pays the referrer when the friend confirms their email, and lifts a level', async () => {
    const anna = await join()
    const friend = await join({ referredBy: anna.referralCode })

    const verified = await markEmailVerified(friend.id)
    expect(verified?.emailVerifiedAt).not.toBeNull()
    expect(verified?.verifiedAt).not.toBeNull()

    const after = await reload(anna.id)
    expect(after.points).toBe(POINTS.referral)
    expect(after.verifiedReferrals).toBe(1)
    expect(after.level).toBe(LEVELS[1]!.level)
    expect(after.priorityAt).toBeNull()
    const types = (await events(anna.id)).map((e) => e.type)
    expect(types).toEqual(['SIGNED_UP', 'FRIEND_JOINED', 'FRIEND_VERIFIED', 'LEVEL_UNLOCKED'])

    // Verifying again (the mail link opened twice) changes nothing.
    await markEmailVerified(friend.id)
    expect((await reload(anna.id)).points).toBe(POINTS.referral)
    expect(await db.waitlistPoint.count({ where: { entryId: anna.id } })).toBe(1)
  })

  it('a phone code also verifies, and is worth points of its own', async () => {
    const anna = await join()
    const friend = await join({ referredBy: anna.referralCode })
    await markPhoneVerified(friend.id, '+46701234569')
    const f = await reload(friend.id)
    expect(f.phone).toBe('+46701234569')
    expect(f.points).toBe(POINTS.phoneVerified)
    expect(f.verifiedAt).not.toBeNull()
    expect((await reload(anna.id)).verifiedReferrals).toBe(1)
    // Email afterwards: already verified, no second referral credit.
    await markEmailVerified(friend.id)
    expect((await reload(anna.id)).verifiedReferrals).toBe(1)
  })

  it('reaches Insider at five: bonus points, priority, one event per level', async () => {
    const anna = await join()
    for (let i = 0; i < 5; i++) {
      const friend = await join({ referredBy: anna.referralCode })
      await markEmailVerified(friend.id)
    }
    const after = await reload(anna.id)
    expect(after.verifiedReferrals).toBe(5)
    expect(after.level).toBe(3)
    expect(after.priorityAt).not.toBeNull()
    const social = LEVELS.find((l) => l.key === 'social')!
    const insider = LEVELS.find((l) => l.key === 'insider')!
    expect(after.points).toBe(5 * POINTS.referral + social.bonus + insider.bonus)
    const unlocked = (await events(anna.id)).filter((e) => e.type === 'LEVEL_UNLOCKED')
    expect(unlocked.map((e) => (e.data as { key: string }).key)).toEqual(['connector', 'social', 'insider'])
  })

  it('applies the boost multiplier to referral points, never to the bonus', async () => {
    await setFlag('waitlist.boostMultiplier', 2)
    const anna = await join()
    const friend = await join({ referredBy: anna.referralCode })
    await markEmailVerified(friend.id)
    expect((await reload(anna.id)).points).toBe(POINTS.referral * 2)
  })

  it('does not count a friend on the same address, but says so', async () => {
    const anna = await join({ ip: '1.2.3.4' })
    const friend = await join({ referredBy: anna.referralCode, ip: '1.2.3.4' })
    await markEmailVerified(friend.id)
    const after = await reload(anna.id)
    expect(after.points).toBe(0)
    expect(after.verifiedReferrals).toBe(0)
    const fv = (await events(anna.id)).find((e) => e.type === 'FRIEND_VERIFIED')
    expect(fv?.data).toMatchObject({ counted: false })
  })

  it('does not count the same phone as the referrer', async () => {
    const anna = await join({ phone: '+46701111111' })
    const friend = await join({ referredBy: anna.referralCode })
    await markPhoneVerified(friend.id, '+46701111111')
    expect((await reload(anna.id)).verifiedReferrals).toBe(0)
  })

  it(`stops counting after ${MAX_REFERRALS_PER_IP} verified friends from one network`, async () => {
    const anna = await join({ ip: '9.9.9.9' })
    for (let i = 0; i <= MAX_REFERRALS_PER_IP; i++) {
      const friend = await join({ referredBy: anna.referralCode, ip: '5.5.5.5' })
      await markEmailVerified(friend.id)
    }
    expect((await reload(anna.id)).verifiedReferrals).toBe(MAX_REFERRALS_PER_IP)
  })

  it('a referrer who left the queue earns nothing', async () => {
    const anna = await join()
    const friend = await join({ referredBy: anna.referralCode })
    await db.waitlistEntry.update({ where: { id: anna.id }, data: { deletedAt: new Date() } })
    await markEmailVerified(friend.id)
    expect((await reload(anna.id)).points).toBe(0)
  })
})

describe('points ledger', () => {
  it('awards once per reason and reference, and caches the sum', async () => {
    const anna = await join()
    await db.$transaction(async (tx) => {
      expect(await awardPoints(tx, anna.id, 100, 'test', 'a')).toBe(true)
      expect(await awardPoints(tx, anna.id, 100, 'test', 'a')).toBe(false)
      expect(await awardPoints(tx, anna.id, 50, 'test', 'b')).toBe(true)
    })
    const after = await reload(anna.id)
    expect(after.points).toBe(150)
    const sum = await db.waitlistPoint.aggregate({ where: { entryId: anna.id }, _sum: { amount: true } })
    expect(sum._sum.amount).toBe(after.points)
  })

  it('profile and interests pay once each, when complete', async () => {
    const anna = await join()
    await updateProfile(anna.id, { handle: 'anna', ageBracket: '21-25' })
    expect((await reload(anna.id)).points).toBe(0)
    await updateProfile(anna.id, { followersBracket: '1k-5k' })
    expect((await reload(anna.id)).points).toBe(POINTS.profileCompleted)
    await updateProfile(anna.id, { categories: ['gym', 'food'], displayName: 'Anna' })
    expect((await reload(anna.id)).points).toBe(POINTS.profileCompleted + POINTS.interests)
    await updateProfile(anna.id, { categories: ['gym'], handle: 'anna2' })
    expect((await reload(anna.id)).points).toBe(POINTS.profileCompleted + POINTS.interests)
    expect((await events(anna.id)).filter((e) => e.type === 'PROFILE_COMPLETED')).toHaveLength(2)
  })

  it('rank follows points, ties broken by who joined first', async () => {
    const a = await join()
    const b = await join({ city: 'goteborg' })
    const c = await join()
    await updateProfile(c.id, { categories: ['gym'] })
    expect((await rankOf(await reload(c.id))).rank).toBe(1)
    expect((await rankOf(a)).rank).toBe(2)
    expect((await rankOf(b)).rank).toBe(3)
    expect(await rankOf(b, 'goteborg')).toEqual({ rank: 1, total: 1, percentile: 100 })
  })

  it('the weekly leaderboard shows this week, per city, with chosen names only', async () => {
    const a = await join()
    const b = await join()
    const other = await join({ city: 'malmo' })
    await updateProfile(a.id, {
      categories: ['gym'],
      displayName: 'Anna',
      handle: 'anna',
      ageBracket: '21-25',
      followersBracket: '1k-5k',
    })
    await updateProfile(b.id, { categories: ['gym'], handle: 'bosse' })
    await updateProfile(other.id, { categories: ['gym'] })
    // Old points do not count this week.
    await db.waitlistPoint.create({
      data: { entryId: b.id, amount: 9999, reason: 'old', refId: '', createdAt: new Date('2020-01-01') },
    })
    const board = await weeklyLeaderboard('stockholm', 10)
    expect(board.map((r) => [r.entryId, r.name, r.points])).toEqual([
      [a.id, 'Anna', POINTS.interests + POINTS.profileCompleted],
      [b.id, '@bosse', POINTS.interests],
    ])
    expect(await weeklyStanding(a)).toEqual({ points: POINTS.interests + POINTS.profileCompleted, rank: 1 })
    expect(await weeklyStanding(b)).toEqual({ points: POINTS.interests, rank: 2 })
    expect(await weeklyStanding(await join())).toEqual({ points: 0, rank: null })
  })

  it('the daily boost draws only when switched on, and only once a day', async () => {
    const a = await join()
    await markEmailVerified(a.id)
    await join() // unverified, never drawn
    expect(await dailyBoost()).toBe(0)
    await setFlag('waitlist.dailyBoostCount', 5)
    expect(await dailyBoost()).toBe(1)
    expect(await dailyBoost()).toBe(0)
    expect((await reload(a.id)).points).toBe(POINTS.dailyBoost)
  })
})

describe('access', () => {
  it('lets priority in first, then points, and only verified people', async () => {
    const points = await join()
    const priority = await join()
    const unverified = await join()
    const plain = await join()
    for (const e of [points, priority, plain]) await markEmailVerified(e.id)
    await db.waitlistEntry.update({ where: { id: points.id }, data: { points: 5000 } })
    await db.waitlistEntry.update({ where: { id: priority.id }, data: { priorityAt: new Date(), points: 10 } })

    const first = await grantAccess(2)
    expect(first.map((e) => e.id)).toEqual([priority.id, points.id])
    expect(first[0]!.accessExpiresAt!.getTime() - first[0]!.accessGrantedAt!.getTime()).toBe(ACCESS_TTL_MS)

    const second = await grantAccess(10)
    expect(second.map((e) => e.id)).toEqual([plain.id])
    expect(await hasAccess(unverified.email)).toBe(false)
    expect((await events(plain.id)).map((e) => e.type)).toContain('ACCESS_GRANTED')
  })

  it('expires after 48 hours unless the account was opened', async () => {
    const a = await join()
    await markEmailVerified(a.id)
    await grantAccess(1)
    expect(await hasAccess(a.email)).toBe(true)
    const later = new Date(Date.now() + ACCESS_TTL_MS + 1000)
    expect(await hasAccess(a.email, later)).toBe(false)
    await markConverted(a.email.toUpperCase(), 'user_1')
    expect(await hasAccess(a.email, later)).toBe(true)
    expect((await reload(a.id)).convertedUserId).toBe('user_1')
    expect((await events(a.id)).map((e) => e.type)).toContain('ACCESS_USED')
  })

  it('gates a new creator at sign-in while the flag is up', async () => {
    await setFlag('waitlist.gate', true)
    expect(await resolveIdentity('nobody@example.se', 'PARTICIPANT')).toEqual({ ok: false, error: 'waitlistOnly' })

    const a = await join()
    await markEmailVerified(a.id)
    expect(await resolveIdentity(a.email, 'PARTICIPANT')).toEqual({ ok: false, error: 'waitlistOnly' })
    await grantAccess(1)
    expect(await resolveIdentity(a.email, 'PARTICIPANT')).toMatchObject({ ok: true, next: '/onboarding' })

    await setFlag('waitlist.gate', false)
    expect(await resolveIdentity('nobody@example.se', 'PARTICIPANT')).toMatchObject({ ok: true, next: '/onboarding' })
  })

  it('tells the person by SMS when consented and by email always', async () => {
    await setFlag('waitlist.smsEnabled', true)
    const texted = await join({ phone: '+46701234570', smsConsent: true })
    const quiet = await join()
    for (const e of [texted, quiet]) await markEmailVerified(e.id)
    const granted = await grantAccess(2)
    clearSentMail()
    for (const e of granted) await announceAccess(e)

    expect(fakeSms.sent).toHaveLength(1)
    expect(fakeSms.sent[0]).toMatchObject({ to: '+46701234570' })
    expect(fakeSms.sent[0]!.message).toMatch(/^DIN TUR!/)
    expect(sentMail.filter((m) => m.tag === 'waitlist_access')).toHaveLength(2)
    expect(await db.waitlistEvent.count({ where: { type: 'ACCESS_GRANTED', notifiedAt: null } })).toBe(0)
  })
})

describe('phone verification', () => {
  it('sends a code once the flag is on, and a correct code verifies', async () => {
    await setFlag('waitlist.smsEnabled', true)
    const a = await join()
    const req = await requestPhoneCode(a, '+46701234571')
    expect(req.ok).toBe(true)
    expect(fakeSms.sent).toHaveLength(1)
    const code = fakeSms.sent[0]!.message.match(/^(\d{6}) /)![1]!

    expect(await verifyPhoneCode('+46701234571', '000000')).toMatchObject({ ok: false, error: 'wrongCode' })
    expect(await verifyPhoneCode('+46701234571', code)).toEqual({ ok: true })
    // Consumed: the same code cannot be used twice.
    expect(await verifyPhoneCode('+46701234571', code)).toMatchObject({ ok: false, error: 'noCode' })
  })

  it('refuses a number someone else already verified', async () => {
    const a = await join()
    await markPhoneVerified(a.id, '+46701234572')
    const b = await join()
    expect(await requestPhoneCode(b, '+46701234572')).toEqual({ ok: false, error: 'phoneTaken' })
  })
})

describe('the digest', () => {
  async function referrerWithFriend(overrides: Partial<JoinInput> = {}) {
    const anna = await join({ phone: '+46701234573', smsConsent: true, ...overrides })
    const friend = await join({ referredBy: anna.referralCode })
    await markEmailVerified(friend.id)
    return anna
  }

  it('sends one text per person with the counted news, and marks the events told', async () => {
    await setFlag('waitlist.smsEnabled', true)
    const anna = await referrerWithFriend()
    const result = await runDigest(NOON)
    expect(result.sent).toBe(1)
    expect(fakeSms.sent).toHaveLength(1)
    expect(fakeSms.sent[0]!.message).toContain('En vän gick med via dig')
    expect(fakeSms.sent[0]!.message).toContain('Connector')
    expect(await db.waitlistEvent.count({ where: { entryId: anna.id, notifiedAt: null } })).toBe(0)
    expect((await reload(anna.id)).lastSmsAt).not.toBeNull()
    expect((await reload(anna.id)).lastNotifiedRank).toBe(1)

    // Nothing new: nothing sent.
    expect((await runDigest(NOON)).sent).toBe(0)
  })

  it('sends nothing without the flag, without consent, or during quiet hours', async () => {
    const anna = await referrerWithFriend()
    expect((await runDigest(NOON)).sent).toBe(0)
    expect(fakeSms.sent).toHaveLength(0)
    // The flag off: the events are still marked told — nobody gets a backlog later.
    expect(await db.waitlistEvent.count({ where: { entryId: anna.id, notifiedAt: null } })).toBe(0)

    await setFlag('waitlist.smsEnabled', true)
    const bosse = await referrerWithFriend({ phone: '+46701234574', smsConsent: false })
    expect((await runDigest(NOON)).sent).toBe(0)
    expect(await db.waitlistEvent.count({ where: { entryId: bosse.id, notifiedAt: null } })).toBe(0)

    const carla = await referrerWithFriend({ phone: '+46701234575' })
    const night = new Date('2026-06-15T23:30:00+02:00')
    expect((await runDigest(night)).sent).toBe(0)
    // Postponed, not dropped: the events wait for the morning.
    expect(await db.waitlistEvent.count({ where: { entryId: carla.id, notifiedAt: null } })).toBeGreaterThan(0)
    expect((await runDigest(NOON)).sent).toBe(1)
  })

  it('waits six hours between texts to the same person', async () => {
    await setFlag('waitlist.smsEnabled', true)
    const anna = await referrerWithFriend()
    expect((await runDigest(NOON)).sent).toBe(1)
    // The send stamps the real clock; pin it to the test's clock.
    await db.waitlistEntry.update({ where: { id: anna.id }, data: { lastSmsAt: NOON } })
    const friend2 = await join({ referredBy: anna.referralCode })
    await markEmailVerified(friend2.id)
    expect((await runDigest(new Date(NOON.getTime() + 3600_000))).sent).toBe(0)
    expect((await runDigest(new Date(NOON.getTime() + 7 * 3600_000))).sent).toBe(1)
    expect(fakeSms.sent).toHaveLength(2)
  })

  it('STOP ends the texts; the page switch would do the same', async () => {
    await setFlag('waitlist.smsEnabled', true)
    const anna = await referrerWithFriend()
    expect(await handleInboundSms('+46701234573', 'STOPP')).toBe(1)
    expect((await reload(anna.id)).smsOptOutAt).not.toBeNull()
    expect((await runDigest(NOON)).sent).toBe(0)
    expect(await handleInboundSms('+46701234573', 'hej')).toBe(0)
    expect(await handleInboundSms('0701234573', 'stop')).toBe(0) // already opted out
  })
})
