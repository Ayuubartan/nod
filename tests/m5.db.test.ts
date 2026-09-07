/**
 * M5 against the database — the parts that read real history.
 *
 * Two properties matter most here and are asserted directly:
 *   - v1 stays dormant on a small campaign, so a pilot's first placements are not
 *     flagged by coincidence
 *   - the fill model reports `heuristic` until a campaign has actually closed, and
 *     `model` afterwards, so a brand is never shown a forecast that pretends to be
 *     data when it is arithmetic
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, makeBrand, makeCampaign, makeParticipant, resetDb } from './helpers/db'
import { collectCrossCampaignSignals, crossCampaignSignalsAreMeaningful } from '@/lib/fraud-v1'
import { countEligibleAccounts, estimateFill, measureHistoricalRates } from '@/lib/fill-model'
import { sek } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import { buildTrainingExport } from '@/inngest/training'

const TEMPLATE = {
  fixedOre: DEFAULTS.fixedOre,
  cpmOre: DEFAULTS.cpmOre,
  viewFloor: DEFAULTS.viewFloor,
  takeRateBps: DEFAULTS.takeRateBps,
}

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

describe('cross-campaign signals stay dormant on a small campaign', () => {
  it('reports the population as not meaningful below 20 decided placements', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })

    expect(await crossCampaignSignalsAreMeaningful(campaign.id)).toBe(false)
  })

  it('turns on once enough placements have been decided', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, perPersonCap: 50 })
    const { user, account } = await makeParticipant()

    for (let i = 0; i < 20; i++) {
      const placement = await db.placement.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          socialAccountId: account.id,
          state: 'PAID',
          reservationOre: sek(90),
          deadlineAt: new Date(),
        },
      })
      await db.verification.create({
        data: { placementId: placement.id, views: 400 + i, decidedAt: new Date(), fraudScore: 0.1 },
      })
    }

    expect(await crossCampaignSignalsAreMeaningful(campaign.id)).toBe(true)
  })
})

describe('cross-campaign signal collection', () => {
  it('counts identical view counts and simultaneous elevated placements', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, perPersonCap: 50 })
    const { user, account } = await makeParticipant()
    const now = new Date()

    // Three other placements reporting exactly 5,000 views, all elevated, all just now.
    for (let i = 0; i < 3; i++) {
      const placement = await db.placement.create({
        data: {
          campaignId: campaign.id,
          userId: user.id,
          socialAccountId: account.id,
          state: 'PAID',
          reservationOre: sek(90),
          deadlineAt: now,
        },
      })
      await db.verification.create({
        data: { placementId: placement.id, views: 5_000, decidedAt: now, fraudScore: 0.55 },
      })
    }

    const subject = await db.placement.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        socialAccountId: account.id,
        state: 'VERIFYING',
        reservationOre: sek(90),
        deadlineAt: now,
      },
    })

    const signals = await collectCrossCampaignSignals({
      placementId: subject.id,
      campaignId: campaign.id,
      userId: user.id,
      views: 5_000,
      decidedAt: now,
    })

    expect(signals.identicalViewCounts).toBe(3)
    expect(signals.simultaneousSpikes).toBe(3)
    expect(signals.accountsUsedOnCampaign).toBe(1)
  })

  it('measures the participant rejection rate across campaigns', async () => {
    const brand = await makeBrand()
    const a = await makeCampaign({ brandId: brand.id, perPersonCap: 50 })
    const b = await makeCampaign({ brandId: brand.id, perPersonCap: 50 })
    const { user, account } = await makeParticipant()

    const make = async (campaignId: string, state: 'PAID' | 'REJECTED') =>
      db.placement.create({
        data: {
          campaignId,
          userId: user.id,
          socialAccountId: account.id,
          state,
          reservationOre: sek(90),
          deadlineAt: new Date(),
        },
      })

    await make(a.id, 'PAID')
    await make(a.id, 'REJECTED')
    await make(b.id, 'REJECTED')
    const subject = await make(b.id, 'PAID')

    const signals = await collectCrossCampaignSignals({
      placementId: subject.id,
      campaignId: b.id,
      userId: user.id,
      views: 500,
    })

    // Three prior terminal placements, two rejected.
    expect(signals.historicalRejectRate).toBeCloseTo(2 / 3, 5)
  })
})

describe('fill model — docs/09 M5 task 5', () => {
  it('falls back to the heuristic and says so when nothing has closed', async () => {
    const brand = await makeBrand()
    await makeCampaign({ brandId: brand.id })
    for (let i = 0; i < 10; i++) await makeParticipant({ state: 'ACTIVE' })

    expect(await measureHistoricalRates()).toBeNull()

    const eligible = await countEligibleAccounts({ cities: [], ageBrackets: [], minFollowers: 300 })
    const estimate = await estimateFill({
      template: TEMPLATE,
      budgetOre: sek(9_000),
      perPlacementMaxOre: DEFAULTS.perPlacementMaxOre,
      medianAvgViews: 451,
      eligibleAccounts: eligible,
    })

    expect(estimate.basis).toBe('heuristic')
    expect(estimate.sampleSize).toBe(0)
    // 9,000 kr at a 90 kr reservation buys 100 placements.
    expect(estimate.placementsAffordable).toBe(100)
  })

  it('uses measured rates once a campaign has closed', async () => {
    const brand = await makeBrand()
    const closed = await makeCampaign({ brandId: brand.id, perPersonCap: 50 })

    // Ten eligible participants; four of them claimed; three of those got paid.
    const participants = []
    for (let i = 0; i < 10; i++) participants.push(await makeParticipant({ state: 'ACTIVE' }))

    for (const [index, p] of participants.slice(0, 4).entries()) {
      await db.placement.create({
        data: {
          campaignId: closed.id,
          userId: p.user.id,
          socialAccountId: p.account.id,
          state: index < 3 ? 'PAID' : 'REJECTED',
          reservationOre: sek(90),
          deadlineAt: new Date(),
          settledAt: index < 3 ? new Date() : null,
        },
      })
    }

    await db.campaign.update({
      where: { id: closed.id },
      data: {
        state: 'CLOSED',
        liveAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    })

    const rates = await measureHistoricalRates()
    expect(rates).not.toBeNull()
    expect(rates!.sampleSize).toBe(1)
    // 4 claimers out of 10 eligible.
    expect(rates!.claimRate).toBeCloseTo(0.4, 5)
    // 3 of 4 placements reached PAID.
    expect(rates!.completionRate).toBeCloseTo(0.75, 5)

    const eligible = await countEligibleAccounts({ cities: [], ageBrackets: [], minFollowers: 300 })
    const estimate = await estimateFill({
      template: TEMPLATE,
      budgetOre: sek(9_000),
      perPlacementMaxOre: DEFAULTS.perPlacementMaxOre,
      medianAvgViews: 451,
      eligibleAccounts: eligible,
      rates,
    })

    expect(estimate.basis).toBe('model')
    expect(estimate.sampleSize).toBe(1)
    // Budget affords 100 placements, but only ~40% of 10 accounts will claim, and 75%
    // of those complete — so the forecast is demand-limited, not budget-limited.
    expect(estimate.percent).toBeLessThan(50)
  })

  it('shortens the forecast when demand outruns the budget', async () => {
    const rates = { claimRate: 1, completionRate: 1, medianDaysToFill: 10, sampleSize: 3 }

    const tight = await estimateFill({
      template: TEMPLATE,
      budgetOre: sek(900), // 10 placements
      perPlacementMaxOre: DEFAULTS.perPlacementMaxOre,
      medianAvgViews: 451,
      eligibleAccounts: 100, // far more demand than budget
      rates,
    })

    expect(tight.basis).toBe('model')
    expect(tight.percent).toBe(100)
    expect(tight.days).toBeLessThan(rates.medianDaysToFill)
  })

  it('never reports more than 100% fill', async () => {
    const estimate = await estimateFill({
      template: TEMPLATE,
      budgetOre: sek(1_000_000),
      perPlacementMaxOre: DEFAULTS.perPlacementMaxOre,
      medianAvgViews: 451,
      eligibleAccounts: 5,
      rates: null,
    })
    expect(estimate.percent).toBeLessThanOrEqual(100)
  })
})

describe('training export — consent is checked at export time', () => {
  it('excludes a participant who has not given consent', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()

    await db.user.update({ where: { id: user.id }, data: { trainingConsent: false } })
    await db.placement.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        socialAccountId: account.id,
        state: 'PAID',
        reservationOre: sek(90),
        deadlineAt: new Date(),
      },
    })

    expect(await buildTrainingExport('2026-09-07')).toHaveLength(0)
  })

  it('includes a consenting participant, pseudonymised and with no absolute timestamps', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()

    await db.user.update({ where: { id: user.id }, data: { trainingConsent: true } })
    const placement = await db.placement.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        socialAccountId: account.id,
        state: 'PAID',
        reservationOre: sek(90),
        deadlineAt: new Date(),
        regionJson: { x: 0.3, y: 0.4, w: 0.2, h: 0.2 },
        assetId: campaign.assets[0]!.id,
      },
    })
    await db.placementEvent.create({
      data: { placementId: placement.id, type: 'APPROVE', payload: { at: new Date().toISOString() } },
    })

    const records = await buildTrainingExport('2026-09-07')
    expect(records).toHaveLength(1)

    const record = records[0]!
    // Neither the participant nor the placement is identifiable from the export.
    expect(record.participant).not.toBe(user.id)
    expect(record.placement).not.toBe(placement.id)
    expect(record.participantApproved).toBe(true)
    expect(record.region).toEqual({ x: 0.3, y: 0.4, w: 0.2, h: 0.2 })

    // Timing is relative, never absolute.
    const dump = JSON.stringify(record)
    expect(dump).not.toContain(user.id)
    expect(dump).not.toContain(account.handle)
    expect(record.events[0]!.atOffsetMs).toBeTypeOf('number')
  })

  it('gives a different pseudonym per export, so exports cannot be joined', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()

    await db.user.update({ where: { id: user.id }, data: { trainingConsent: true } })
    await db.placement.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        socialAccountId: account.id,
        state: 'PAID',
        reservationOre: sek(90),
        deadlineAt: new Date(),
      },
    })

    const first = await buildTrainingExport('2026-09-07')
    const second = await buildTrainingExport('2026-09-14')

    expect(first[0]!.participant).not.toBe(second[0]!.participant)
  })
})
