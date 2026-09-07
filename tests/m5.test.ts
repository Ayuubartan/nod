/**
 * M5 logic — docs/09 M5 tasks 1, 3, 4, 5 and 7.
 *
 * These are the pure parts: fraud v1 scoring, geo derivation, the fill model's
 * arithmetic, the inpaint prompt and mask geometry, Swish instruction ids, and the
 * multi-market eID selection. The database-backed parts are covered in m5.db.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { assessFraud } from '@/lib/fraud'
import { assessFraudV1, geoMatchFrom, type CrossCampaignSignals } from '@/lib/fraud-v1'
import { LIMITS } from '@/lib/money/rates'
import { buildPrompt } from '@/lib/integrations/inpaint'
import { instructionId } from '@/lib/integrations/swish-api'
import { ACR_VALUES, acrFor, birthYearFromSubject, currentMarket } from '@/lib/integrations/bankid'

const cleanAccount = {
  views: 500,
  avgViews30d: 450,
  followers: 820,
  accountAgeDays: 500,
  engagements: 40,
  priorQualified: 5,
  priorFraudRejects: 0,
}

const noSignals: CrossCampaignSignals = {
  simultaneousSpikes: 0,
  identicalViewCounts: 0,
  nearMissCount: 0,
  historicalRejectRate: 0,
  accountsUsedOnCampaign: 1,
}

describe('fraud v1 — cross-campaign patterns', () => {
  it('leaves a clean placement with no population signals exactly where v0 put it', () => {
    const v0 = assessFraud(cleanAccount)
    const v1 = assessFraudV1(cleanAccount, noSignals)

    expect(v1.score).toBe(v0.score)
    expect(v1.flagged).toBe(false)
  })

  it('can never lower a score that v0 already flagged', () => {
    const suspicious = {
      ...cleanAccount,
      views: 40_000,
      avgViews30d: 300,
      accountAgeDays: 5,
      engagements: 2,
      priorQualified: 0,
    }
    const v0 = assessFraud(suspicious)
    const v1 = assessFraudV1(suspicious, noSignals)

    expect(v0.flagged).toBe(true)
    expect(v1.score).toBeGreaterThanOrEqual(v0.score)
    expect(v1.flagged).toBe(true)
  })

  it('flags a coordinated ring that each member alone would pass', () => {
    // Every individual number here is unremarkable.
    const v0 = assessFraud(cleanAccount)
    expect(v0.flagged).toBe(false)

    const ring = assessFraudV1(cleanAccount, {
      simultaneousSpikes: 6,
      identicalViewCounts: 4,
      nearMissCount: 2,
      historicalRejectRate: 0.5,
      accountsUsedOnCampaign: 1,
    })

    expect(ring.score).toBeGreaterThan(v0.score)
    expect(ring.flagged).toBe(true)
  })

  it('does not flag on a single coincidental co-occurrence', () => {
    const one = assessFraudV1(cleanAccount, { ...noSignals, simultaneousSpikes: 1 })
    expect(one.flagged).toBe(false)
  })

  it('names every cross-campaign factor so ops can defend the decision', () => {
    const result = assessFraudV1(cleanAccount, {
      simultaneousSpikes: 3,
      identicalViewCounts: 2,
      nearMissCount: 1,
      historicalRejectRate: 0.4,
      accountsUsedOnCampaign: 2,
    })

    const names = result.factors.map((f) => f.name)
    // v0's five factors are preserved and the four v1 ones are appended.
    expect(names).toEqual([
      'velocity', 'reach_vs_followers', 'account_age', 'engagement', 'history',
      'cluster_timing', 'identical_views', 'threshold_probing', 'reject_rate',
    ])
    for (const factor of result.factors) {
      expect(factor.detail.length).toBeGreaterThan(0)
    }
  })

  it('only discounts payment well above the flag threshold', () => {
    const mild = assessFraudV1(cleanAccount, { ...noSignals, simultaneousSpikes: 3 })
    expect(mild.fraudDiscount).toBe(0)

    const severe = assessFraudV1(
      { ...cleanAccount, views: 60_000, avgViews30d: 200, accountAgeDays: 2, engagements: 0, priorQualified: 0, priorFraudRejects: 1 },
      { simultaneousSpikes: 8, identicalViewCounts: 6, nearMissCount: 4, historicalRejectRate: 1, accountsUsedOnCampaign: 3 },
    )
    expect(severe.score).toBeGreaterThan(LIMITS.fraudFlagThreshold)
  })

  it('keeps the score inside 0..1 under every combination', () => {
    for (const spikes of [0, 5, 50]) {
      for (const identical of [0, 3, 30]) {
        const result = assessFraudV1(cleanAccount, {
          simultaneousSpikes: spikes,
          identicalViewCounts: identical,
          nearMissCount: 10,
          historicalRejectRate: 1,
          accountsUsedOnCampaign: 5,
        })
        expect(result.score).toBeGreaterThanOrEqual(0)
        expect(result.score).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('geo from the API — docs/09 M5 task 4', () => {
  it('is the share of the audience in the campaign countries', () => {
    expect(geoMatchFrom({ SE: 800, NO: 200 }, ['SE'])).toBe(0.8)
    expect(geoMatchFrom({ SE: 500, DK: 300, NO: 200 }, ['SE', 'DK'])).toBe(0.8)
    expect(geoMatchFrom({ SE: 1000 }, ['SE'])).toBe(1)
  })

  it('is case-insensitive on country codes', () => {
    expect(geoMatchFrom({ se: 900, no: 100 }, ['SE'])).toBe(0.9)
  })

  it('returns null rather than zero when the audience is unknown', () => {
    // Null means "no adjustment". Zero would mean "pay nothing", which is not something
    // a missing API field should ever cause.
    expect(geoMatchFrom(null, ['SE'])).toBeNull()
    expect(geoMatchFrom(undefined, ['SE'])).toBeNull()
    expect(geoMatchFrom({}, ['SE'])).toBeNull()
    expect(geoMatchFrom({ SE: 0 }, ['SE'])).toBeNull()
  })

  it('is zero when a real audience genuinely does not match', () => {
    expect(geoMatchFrom({ US: 1000 }, ['SE'])).toBe(0)
  })
})

describe('inpaint prompt — docs/09 M5 task 1', () => {
  it('asks for a photograph, not an advert', () => {
    const prompt = buildPrompt('Kaffepåse 500g', 'centre')

    expect(prompt).toContain('Kaffepåse 500g')
    expect(prompt).toContain('in the centre of the scene')
    // The whole thesis is that a placement looks like it was already there.
    expect(prompt).toMatch(/lighting/i)
    expect(prompt).toMatch(/not a sticker/i)
    expect(prompt).toMatch(/no added text/i)
    expect(prompt).toMatch(/unchanged/i)
  })

  it('handles a region with no label', () => {
    expect(buildPrompt('Logo')).toContain('in the marked area')
  })
})

describe('Swish instruction ids — docs/09 M5 task 3', () => {
  it('is deterministic, so retrying the same payout cannot pay twice', () => {
    const a = instructionId('batch1', 'wallet1')
    const b = instructionId('batch1', 'wallet1')
    expect(a).toBe(b)
  })

  it('differs per wallet and per batch', () => {
    expect(instructionId('batch1', 'wallet1')).not.toBe(instructionId('batch1', 'wallet2'))
    expect(instructionId('batch1', 'wallet1')).not.toBe(instructionId('batch2', 'wallet1'))
  })

  it('is the 32 uppercase hex characters Swish expects', () => {
    expect(instructionId('b', 'w')).toMatch(/^[0-9A-F]{32}$/)
  })
})

describe('multi-market eID — docs/09 M5 task 7', () => {
  it('covers the Nordic markets the broker reaches', () => {
    expect(ACR_VALUES.SE).toContain('se:bankid')
    expect(ACR_VALUES.DK).toContain('dk:mitid')
    expect(ACR_VALUES.NO).toContain('no:bankid')
    expect(ACR_VALUES.FI).toContain('fi:')
  })

  it('defaults to Sweden and ignores an unknown market', () => {
    const original = process.env.NOD_MARKET
    try {
      delete process.env.NOD_MARKET
      expect(currentMarket()).toBe('SE')

      process.env.NOD_MARKET = 'DK'
      expect(currentMarket()).toBe('DK')

      process.env.NOD_MARKET = 'dk'
      expect(currentMarket()).toBe('DK')

      process.env.NOD_MARKET = 'XX'
      expect(currentMarket()).toBe('SE')
    } finally {
      if (original === undefined) delete process.env.NOD_MARKET
      else process.env.NOD_MARKET = original
    }
  })

  it('picks same-device on mobile and QR on desktop for Swedish BankID', () => {
    // docs/06 section 3. Verified against the broker's docs 2026-09-07.
    expect(acrFor('SE', 'mobile')).toBe('urn:grn:authn:se:bankid:same-device')
    expect(acrFor('SE', 'desktop')).toBe('urn:grn:authn:se:bankid:qr')
    expect(acrFor('SE')).toBe('urn:grn:authn:se:bankid')
  })

  it('never invents a device variant for a market that does not document one', () => {
    for (const market of ['DK', 'NO', 'FI'] as const) {
      expect(acrFor(market, 'mobile')).toBe(ACR_VALUES[market])
      expect(acrFor(market, 'desktop')).toBe(ACR_VALUES[market])
    }
  })

  it('reads a birth year from a personnummer and from an ISO birthdate', () => {
    // Swedish BankID returns a personnummer; MitID returns a birthdate.
    expect(birthYearFromSubject('199505054321')).toBe(1995)
    expect(birthYearFromSubject('19950505-4321')).toBe(1995)
    expect(birthYearFromSubject('1995-05-05')).toBe(1995)
  })

  it('rejects anything it cannot read a plausible year from', () => {
    expect(birthYearFromSubject('')).toBeNull()
    expect(birthYearFromSubject('abc')).toBeNull()
    expect(birthYearFromSubject('1899-01-01')).toBeNull()
    expect(birthYearFromSubject('2999-01-01')).toBeNull()
    expect(birthYearFromSubject('123')).toBeNull()
  })
})
