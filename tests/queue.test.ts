/**
 * The waitlist game's pure rules (docs/13) — levels, phone numbers, percentiles,
 * who a referral counts for, what a digest says, and when the week starts.
 */

import { describe, expect, it } from 'vitest'
import {
  LEVELS,
  MAX_REFERRALS_PER_IP,
  levelFor,
  nextLevel,
  normalisePhone,
  percentile,
  progressBar,
  referralCounts,
  weekStart,
} from '@/lib/queue'
import { accessMessage, composeDigest, isQuietHour, mayReceiveDigest } from '@/lib/waitlist-sms'

describe('levels', () => {
  it('follows the spec ladder: 0 / 1 / 3 / 5 / 10 verified referrals', () => {
    expect(LEVELS.map((l) => [l.key, l.referrals])).toEqual([
      ['queue', 0],
      ['connector', 1],
      ['social', 3],
      ['insider', 5],
      ['founding', 10],
    ])
    expect(levelFor(0).key).toBe('queue')
    expect(levelFor(1).key).toBe('connector')
    expect(levelFor(2).key).toBe('connector')
    expect(levelFor(3).key).toBe('social')
    expect(levelFor(5).key).toBe('insider')
    expect(levelFor(9).key).toBe('insider')
    expect(levelFor(10).key).toBe('founding')
    expect(levelFor(40).key).toBe('founding')
  })

  it('priority access starts at Insider', () => {
    expect(LEVELS.filter((l) => l.priority).map((l) => l.key)).toEqual(['insider', 'founding'])
  })

  it('knows the next goal and how far it is', () => {
    expect(nextLevel(0)).toMatchObject({ level: { key: 'connector' }, remaining: 1 })
    expect(nextLevel(1)).toMatchObject({ level: { key: 'social' }, remaining: 2 })
    expect(nextLevel(4)).toMatchObject({ level: { key: 'insider' }, remaining: 1 })
    expect(nextLevel(10)).toBeNull()
  })

  it('draws ten blocks', () => {
    expect(progressBar(0, 3)).toBe('░░░░░░░░░░')
    expect(progressBar(1, 2)).toBe('█████░░░░░')
    expect(progressBar(3, 3)).toBe('██████████')
  })
})

describe('normalisePhone', () => {
  it('accepts Swedish mobiles in every common spelling', () => {
    for (const raw of ['070-123 45 67', '0701234567', '+46 70 123 45 67', '0046701234567', '46701234567', '+46701234567']) {
      expect(normalisePhone(raw)).toBe('+46701234567')
    }
  })

  it('refuses landlines, foreign numbers and typos', () => {
    for (const raw of ['08-123 45 67', '+4512345678', '070123456', '07012345678', '', 'hej']) {
      expect(normalisePhone(raw)).toBeNull()
    }
  })
})

describe('percentile', () => {
  it('rounds up, so the number shown is never better than the truth', () => {
    expect(percentile(1, 1)).toBe(100)
    expect(percentile(1, 1000)).toBe(1)
    expect(percentile(3, 1000)).toBe(1)
    expect(percentile(11, 1000)).toBe(2)
    expect(percentile(500, 1000)).toBe(50)
    expect(percentile(1, 0)).toBe(100)
  })
})

describe('referralCounts', () => {
  const referrer = { email: 'anna@example.se', phone: '+46701111111', ipHash: 'aaa' }

  it('counts a different person on a different network', () => {
    expect(referralCounts({ referrer, entry: { email: 'b@example.se', phone: null, ipHash: 'bbb' }, sameIpVerified: 0 })).toBe(true)
  })

  it('never counts yourself — by email, phone or address', () => {
    expect(referralCounts({ referrer, entry: { email: 'ANNA@example.se', phone: null, ipHash: 'zzz' }, sameIpVerified: 0 })).toBe(false)
    expect(referralCounts({ referrer, entry: { email: 'b@example.se', phone: '+46701111111', ipHash: 'zzz' }, sameIpVerified: 0 })).toBe(false)
    expect(referralCounts({ referrer, entry: { email: 'b@example.se', phone: null, ipHash: 'aaa' }, sameIpVerified: 0 })).toBe(false)
  })

  it(`stops counting after ${MAX_REFERRALS_PER_IP} verified friends from one address`, () => {
    const entry = { email: 'b@example.se', phone: null, ipHash: 'bbb' }
    expect(referralCounts({ referrer, entry, sameIpVerified: MAX_REFERRALS_PER_IP - 1 })).toBe(true)
    expect(referralCounts({ referrer, entry, sameIpVerified: MAX_REFERRALS_PER_IP })).toBe(false)
  })
})

describe('composeDigest', () => {
  const rank = { rank: 12, total: 400, percentile: 3 }

  it('says nothing when nothing counted', () => {
    expect(composeDigest({ entry: { verifiedReferrals: 0, lastNotifiedRank: null }, events: [], rank })).toBeNull()
    expect(
      composeDigest({
        entry: { verifiedReferrals: 0, lastNotifiedRank: null },
        events: [{ type: 'FRIEND_VERIFIED', data: { counted: false } }],
        rank,
      }),
    ).toBeNull()
  })

  it('counts only friends who counted, and shows the jump', () => {
    const text = composeDigest({
      entry: { verifiedReferrals: 2, lastNotifiedRank: 40 },
      events: [
        { type: 'FRIEND_VERIFIED', data: { counted: true } },
        { type: 'FRIEND_VERIFIED', data: { counted: false } },
        { type: 'FRIEND_VERIFIED', data: { counted: true } },
      ],
      rank,
    })
    expect(text).toContain('2 vänner gick med via dig')
    expect(text).toContain('hoppade 28 platser till #12')
    expect(text).toContain('En vän till → Social')
    expect(text).toMatch(/– Booga$/)
  })

  it('celebrates a level with priority', () => {
    const text = composeDigest({
      entry: { verifiedReferrals: 5, lastNotifiedRank: null },
      events: [
        { type: 'FRIEND_VERIFIED', data: { counted: true } },
        { type: 'LEVEL_UNLOCKED', data: { key: 'insider' } },
      ],
      rank,
    })
    expect(text).toContain('En vän gick med via dig – du är #12.')
    expect(text).toContain('Insider med prioriterad access')
  })

  it('the access message says DIN TUR and 48h', () => {
    const text = accessMessage('https://joinbooga.se/queue?t=abc')
    expect(text).toMatch(/^DIN TUR!/)
    expect(text).toContain('48h')
    expect(text).toContain('https://joinbooga.se/queue?t=abc')
  })
})

describe('SMS timing', () => {
  it('is quiet between 22 and 08 Stockholm time', () => {
    expect(isQuietHour(new Date('2026-06-15T21:30:00+02:00'))).toBe(false)
    expect(isQuietHour(new Date('2026-06-15T22:00:00+02:00'))).toBe(true)
    expect(isQuietHour(new Date('2026-06-16T07:59:00+02:00'))).toBe(true)
    expect(isQuietHour(new Date('2026-06-16T08:00:00+02:00'))).toBe(false)
  })

  it('needs consent, no STOP, a phone, and six hours since the last text', () => {
    const noon = new Date('2026-06-15T12:00:00+02:00')
    const base = { phone: '+46701234567', smsConsentAt: new Date(), smsOptOutAt: null, lastSmsAt: null }
    expect(mayReceiveDigest(base, noon)).toBe(true)
    expect(mayReceiveDigest({ ...base, phone: null }, noon)).toBe(false)
    expect(mayReceiveDigest({ ...base, smsConsentAt: null }, noon)).toBe(false)
    expect(mayReceiveDigest({ ...base, smsOptOutAt: new Date() }, noon)).toBe(false)
    expect(mayReceiveDigest({ ...base, lastSmsAt: new Date(noon.getTime() - 5 * 3600_000) }, noon)).toBe(false)
    expect(mayReceiveDigest({ ...base, lastSmsAt: new Date(noon.getTime() - 7 * 3600_000) }, noon)).toBe(true)
  })
})

describe('weekStart', () => {
  it('is Monday 00:00 Stockholm, whatever the day', () => {
    // Wednesday 10 June 2026 15:00 CEST → Monday 8 June 00:00 CEST (22:00 UTC Sunday).
    expect(weekStart(new Date('2026-06-10T13:00:00Z')).toISOString()).toBe('2026-06-07T22:00:00.000Z')
    // Sunday late evening still belongs to the same week.
    expect(weekStart(new Date('2026-06-14T21:30:00Z')).toISOString()).toBe('2026-06-07T22:00:00.000Z')
    // A Monday is its own week start.
    expect(weekStart(new Date('2026-06-15T05:00:00Z')).toISOString()).toBe('2026-06-14T22:00:00.000Z')
  })
})
