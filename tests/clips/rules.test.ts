import { describe, expect, it } from 'vitest'
import { parsePostUrl, PostUrlParseError, tryParsePostUrl } from '@/lib/post-url'
import {
  bucketOf,
  cadenceFor,
  checkCaption,
  clipRiskFactors,
  insidePublishWindow,
  nextCheckAt,
  riskBand,
  submissionReservationOre,
} from '@/lib/clips/rules'

/** Pure clip rules — docs/14 §3-5. No database. */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('parsePostUrl', () => {
  it('parses TikTok video and photo links to the numeric id', () => {
    expect(parsePostUrl('https://www.tiktok.com/@lisa.se/video/7234567890123456789?is_from_webapp=1')).toEqual({
      platform: 'TIKTOK',
      postId: '7234567890123456789',
      canonicalUrl: 'https://www.tiktok.com/@lisa.se/video/7234567890123456789',
      mediaType: 'video',
    })
    expect(parsePostUrl('tiktok.com/@lisa/photo/7234567890123456789').mediaType).toBe('photo')
    expect(parsePostUrl('https://m.tiktok.com/v/7234567890123456789.html').postId).toBe('7234567890123456789')
  })

  it('parses Instagram reels and posts to the shortcode', () => {
    expect(parsePostUrl('https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=abc')).toEqual({
      platform: 'INSTAGRAM',
      postId: 'C1a2B3c4D5e',
      canonicalUrl: 'https://www.instagram.com/reel/C1a2B3c4D5e/',
      mediaType: 'reel',
    })
    expect(parsePostUrl('https://instagram.com/p/C1a2B3c4D5e').mediaType).toBe('post')
    expect(parsePostUrl('https://www.instagram.com/lisa/reels/C1a2B3c4D5e/').canonicalUrl).toBe('https://www.instagram.com/reel/C1a2B3c4D5e/')
  })

  it('refuses what it cannot track', () => {
    expect(() => parsePostUrl('https://vm.tiktok.com/ZMabc123/')).toThrow(PostUrlParseError)
    expect(tryParsePostUrl('https://vm.tiktok.com/ZMabc123/')).toEqual({ ok: false, code: 'SHORT_LINK' })
    expect(tryParsePostUrl('https://www.instagram.com/stories/lisa/123456/')).toEqual({ ok: false, code: 'STORY' })
    expect(tryParsePostUrl('https://youtube.com/watch?v=abc')).toEqual({ ok: false, code: 'UNSUPPORTED_HOST' })
    expect(tryParsePostUrl('https://www.tiktok.com/@lisa')).toEqual({ ok: false, code: 'NO_POST_ID' })
    expect(tryParsePostUrl('not a url at all ://')).toEqual({ ok: false, code: 'INVALID_URL' })
  })
})

describe('checkCaption', () => {
  const rules = { disclosureText: 'Reklam – i samarbete med Kaffeklubben', requiredHashtags: ['#kaffeklubben'], requiredMentions: ['@kaffeklubben'] }

  it('passes with the issued phrase plus required tags', () => {
    const r = checkCaption('Reklam – i samarbete med Kaffeklubben ☕ @kaffeklubben #kaffeklubben #morgon', rules)
    expect(r).toEqual({ disclosureOk: true, missingHashtags: [], missingMentions: [], ok: true })
  })

  it('accepts a disclosure hashtag anywhere and the paid-partnership label', () => {
    expect(checkCaption('bästa kaffet #kaffeklubben @kaffeklubben #reklam', rules).disclosureOk).toBe(true)
    expect(checkCaption('bästa kaffet #kaffeklubben @kaffeklubben', rules, true).ok).toBe(true)
  })

  it('reports exactly what is missing', () => {
    const r = checkCaption('bästa kaffet #morgon', rules)
    expect(r).toEqual({ disclosureOk: false, missingHashtags: ['kaffeklubben'], missingMentions: ['kaffeklubben'], ok: false })
    expect(checkCaption(null, rules).ok).toBe(false)
  })
})

describe('publish window and cadence', () => {
  const now = new Date('2026-09-09T12:00:00Z')

  it('allows 24h before go-live and nothing after the end', () => {
    const campaign = { liveAt: new Date('2026-09-09T00:00:00Z'), startsAt: null, endsAt: new Date('2026-09-30T00:00:00Z') }
    expect(insidePublishWindow(new Date('2026-09-08T06:00:00Z'), campaign)).toBe(true)
    expect(insidePublishWindow(new Date('2026-09-07T06:00:00Z'), campaign)).toBe(false)
    expect(insidePublishWindow(new Date('2026-10-01T00:00:00Z'), campaign)).toBe(false)
    expect(insidePublishWindow(now, { liveAt: null, startsAt: null, endsAt: null })).toBe(true)
  })

  it('follows the docs/14 §4 table', () => {
    expect(cadenceFor(1 * HOUR)).toEqual({ delayMs: 10 * MIN, priority: 0 })
    expect(cadenceFor(12 * HOUR)).toEqual({ delayMs: 30 * MIN, priority: 1 })
    expect(cadenceFor(2 * DAY)).toEqual({ delayMs: 60 * MIN, priority: 2 })
    expect(cadenceFor(10 * DAY)).toEqual({ delayMs: 4 * HOUR, priority: 3 })
    expect(cadenceFor(30 * DAY)).toEqual({ delayMs: 24 * HOUR, priority: 4 })
  })

  it('backs off on repeated failures and never schedules past the validation end', () => {
    const published = new Date(now.getTime() - HOUR)
    expect(nextCheckAt(now, published, 0, null).at.getTime()).toBe(now.getTime() + 10 * MIN)
    expect(nextCheckAt(now, published, 2, null).at.getTime()).toBe(now.getTime() + 10 * MIN)
    expect(nextCheckAt(now, published, 3, null).at.getTime()).toBe(now.getTime() + 20 * MIN)
    expect(nextCheckAt(now, published, 4, null).at.getTime()).toBe(now.getTime() + 40 * MIN)
    expect(nextCheckAt(now, published, 20, null).at.getTime()).toBe(now.getTime() + DAY)
    const end = new Date(now.getTime() + 3 * MIN)
    expect(nextCheckAt(now, published, 0, end).at).toEqual(end)
  })

  it('buckets by 5 minutes', () => {
    expect(bucketOf(new Date('2026-09-09T12:04:59Z'))).toBe(bucketOf(new Date('2026-09-09T12:00:00Z')))
    expect(bucketOf(new Date('2026-09-09T12:05:00Z'))).toBe(bucketOf(new Date('2026-09-09T12:00:00Z')) + 1)
  })
})

describe('reservation and risk', () => {
  it('reserves the cap, the remainder, or nothing (D2)', () => {
    expect(submissionReservationOre(50_000, 1_000_000)).toBe(50_000)
    expect(submissionReservationOre(50_000, 12_000)).toBe(12_000)
    expect(submissionReservationOre(50_000, 0)).toBe(0)
    expect(submissionReservationOre(50_000, -5)).toBe(0)
  })

  it('flags a single-interval spike and flat increments, ignores small series', () => {
    const t0 = Date.now()
    const at = (i: number, views: number) => ({ observedAt: new Date(t0 + i * HOUR), views })
    expect(clipRiskFactors([at(0, 100), at(1, 200)])).toEqual([])

    const spike = clipRiskFactors([at(0, 100), at(1, 150), at(2, 9000), at(3, 9100)])
    expect(spike.map((f) => f.name)).toEqual(['single_interval_spike'])

    const flat = clipRiskFactors([at(0, 0), at(1, 500), at(2, 1000), at(3, 1500), at(4, 2000), at(5, 2500)])
    expect(flat.map((f) => f.name)).toEqual(['flat_increments'])

    const organic = clipRiskFactors([at(0, 0), at(1, 320), at(2, 610), at(3, 850), at(4, 1010), at(5, 1120)])
    expect(organic).toEqual([])

    const drop = clipRiskFactors([at(0, 1000), at(1, 1200), at(2, 900)])
    expect(drop.map((f) => f.name)).toEqual(['views_decreased'])
  })

  it('maps the combined score to the spec bands', () => {
    expect(riskBand({ score: 0.1 }, [])).toEqual({ score: 10, disposition: 'ALLOW' })
    expect(riskBand({ score: 0.35 }, [])).toEqual({ score: 35, disposition: 'ALLOW_WITH_MONITORING' })
    expect(riskBand({ score: 0.3 }, [{ name: 'single_interval_spike', score: 0.8, detail: '' }])).toEqual({ score: 70, disposition: 'HOLD_FOR_REVIEW' })
    expect(riskBand({ score: 0.9 }, [])).toEqual({ score: 90, disposition: 'REJECT_SUBMISSION' })
  })
})
