/**
 * Campaign lifecycle against the database — docs/09 M2 and M4 acceptance criteria,
 * including edge cases 1 (auto-reopen) and 4 (pause mid-flight).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, makeBrand, makeCampaign, makeParticipant, resetDb } from '../helpers/db'
import { campaignBalance, reconciles } from '@/lib/money/balances'
import { sek } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import { GuardError, TransitionError } from '@/lib/state/transition'
import {
  allPlacementsTerminal,
  approve,
  close,
  exhaust,
  fillPercent,
  fund,
  goLive,
  pause,
  reconcile,
  reopen,
  returnToBrand,
  submit,
  resubmit,
} from '@/lib/state/campaign'
import {
  brandApprove,
  claim,
  expire,
  generationDone,
  markPaid,
  participantApprove,
  position,
  publish,
  holdEnded,
  qualify,
  startGeneration,
  upload,
} from '@/lib/state/placement'
import { assertCampaignReconciles } from '@/lib/state/money'

const OPS = { kind: 'OPS' as const, id: 'ops-1' }
const BRAND = { kind: 'BRAND' as const, id: 'brand-1' }
const PARTICIPANT = { kind: 'PARTICIPANT' as const, id: 'p' }

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

/** A DRAFT campaign complete enough to submit. */
async function makeSubmittableDraft(budgetOre = sek(10_000)) {
  const brand = await makeBrand()
  const campaign = await makeCampaign({ brandId: brand.id, state: 'DRAFT', budgetOre, fundOre: 0 })
  return { brand, campaign }
}

describe('builder to funded', () => {
  it('walks DRAFT -> SUBMITTED -> AWAITING_FUNDS -> FUNDED -> LIVE', async () => {
    const { campaign } = await makeSubmittableDraft()

    expect(await submit(campaign.id, BRAND)).toBe('SUBMITTED')
    expect(await approve(campaign.id, OPS)).toBe('AWAITING_FUNDS')
    expect(await fund(campaign.id, { amountOre: sek(10_000), via: 'card', externalRef: 'pi_1' })).toBe('FUNDED')
    expect(await goLive(campaign.id)).toBe('LIVE')

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.depositedOre).toBe(sek(10_000))
    expect(balance.availableOre).toBe(sek(10_000))
    expect(reconciles(balance)).toBe(true)
  })

  it('refuses to submit a campaign with no budget, template, assets or period', async () => {
    const brand = await makeBrand()
    const bare = await db.campaign.create({
      data: { brandId: brand.id, name: 'Bare', state: 'DRAFT', budget: 0 },
    })

    await expect(submit(bare.id, BRAND)).rejects.toThrow(GuardError)
  })

  it('returns a campaign to the brand with notes and accepts a resubmission', async () => {
    const { campaign } = await makeSubmittableDraft()
    await submit(campaign.id, BRAND)

    expect(await returnToBrand(campaign.id, 'Disclosure text is wrong', OPS)).toBe('RETURNED')
    const returned = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })
    expect(returned.returnedNotes).toBe('Disclosure text is wrong')

    expect(await resubmit(campaign.id, BRAND)).toBe('SUBMITTED')
    const resubmitted = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })
    expect(resubmitted.returnedNotes).toBeNull()
  })

  it('refuses a deposit smaller than the budget', async () => {
    const { campaign } = await makeSubmittableDraft(sek(10_000))
    await submit(campaign.id, BRAND)
    await approve(campaign.id, OPS)

    await expect(fund(campaign.id, { amountOre: sek(5_000), via: 'card' })).rejects.toThrow(/UNDERFUNDED|less than/)
  })

  it('adds a credit-terms fee on an invoiced campaign and none on card', async () => {
    const invoiced = await makeSubmittableDraft(sek(100_000))
    await db.campaign.update({
      where: { id: invoiced.campaign.id },
      data: { creditTermsFeeBps: DEFAULTS.creditTermsFeeBps },
    })
    await submit(invoiced.campaign.id, BRAND)
    await approve(invoiced.campaign.id, OPS)
    await fund(invoiced.campaign.id, { amountOre: sek(100_000), via: 'invoice' })

    const fees = await db.ledgerEntry.findMany({
      where: { campaignId: invoiced.campaign.id, type: 'CREDIT_TERMS_FEE' },
    })
    expect(fees).toHaveLength(1)
    expect(fees[0]!.amountOre).toBe(sek(4_000))

    const card = await makeSubmittableDraft(sek(100_000))
    await submit(card.campaign.id, BRAND)
    await approve(card.campaign.id, OPS)
    await fund(card.campaign.id, { amountOre: sek(100_000), via: 'card' })

    const noFees = await db.ledgerEntry.count({
      where: { campaignId: card.campaign.id, type: 'CREDIT_TERMS_FEE' },
    })
    expect(noFees).toBe(0)
  })

  it('snapshots the take rate at funding', async () => {
    const { campaign } = await makeSubmittableDraft()
    await submit(campaign.id, BRAND)
    await approve(campaign.id, OPS)
    await fund(campaign.id, { amountOre: sek(10_000), via: 'card' })

    const template = await db.payoutTemplate.findUniqueOrThrow({ where: { campaignId: campaign.id } })
    expect(template.takeRateBps).toBe(DEFAULTS.takeRateBps)
  })

  it('never goes live without funding', async () => {
    const { campaign } = await makeSubmittableDraft()
    await expect(goLive(campaign.id)).rejects.toThrow(TransitionError)

    await submit(campaign.id, BRAND)
    await approve(campaign.id, OPS)
    await expect(goLive(campaign.id)).rejects.toThrow(TransitionError)
  })
})

describe('edge case 4 — brand pauses mid-flight', () => {
  it('stops new claims, honours open ones, and refunds the remainder at close', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, budgetOre: sek(1_000), fundOre: sek(1_000) })

    const a = await makeParticipant({ avgViews30d: 450 })
    const claimed = await claim({ campaignId: campaign.id, userId: a.user.id, socialAccountId: a.account.id })

    await pause(campaign.id, 'Brand pulled the campaign', BRAND)

    // No new claims.
    const b = await makeParticipant({ avgViews30d: 450 })
    await expect(
      claim({ campaignId: campaign.id, userId: b.user.id, socialAccountId: b.account.id }),
    ).rejects.toThrow(/PAUSED|not claimable/i)

    // The open claim completes and is paid.
    await upload({ placementId: claimed.id, storagePath: 'o.jpg', perceptualHash: 'e'.repeat(16), contentType: 'story' }, PARTICIPANT)
    await position(claimed.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
    await startGeneration(claimed.id)
    await generationDone(claimed.id, { storagePath: 'v.jpg', engine: 'fake' })
    await participantApprove(claimed.id, PARTICIPANT)
    await brandApprove(claimed.id, BRAND)
    await publish(claimed.id, { postUrl: 'https://instagram.com/p/paused' }, PARTICIPANT)
    await holdEnded(claimed.id)
    await db.verification.create({ data: { placementId: claimed.id, views: 450, viewsSource: 'api' } })
    await qualify(claimed.id, 450)
    await markPaid(claimed.id)

    expect(await allPlacementsTerminal(campaign.id)).toBe(true)
    await reconcile(campaign.id)
    const { returnedOre } = await close(campaign.id, { mode: 'refund' })

    expect(returnedOre).toBe(sek(1_000) - sek(57))

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.availableOre).toBe(0)
    expect(balance.spentOre).toBe(sek(57))
    expect(balance.refundedOre).toBe(sek(1_000) - sek(57))
    expect(reconciles(balance)).toBe(true)
    await assertCampaignReconciles(campaign.id)
  })
})

describe('edge case 1 — auto-reopen after releases', () => {
  it('reopens once when more than 20% of the budget has been released', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, budgetOre: sek(180), fundOre: sek(180) })

    const a = await makeParticipant({ avgViews30d: 450 })
    const b = await makeParticipant({ avgViews30d: 450 })
    const first = await claim({ campaignId: campaign.id, userId: a.user.id, socialAccountId: a.account.id })
    await claim({ campaignId: campaign.id, userId: b.user.id, socialAccountId: b.account.id })

    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).state).toBe('EXHAUSTED')

    // Under 20% released: the guard refuses.
    await expect(reopen(campaign.id)).rejects.toThrow(/NOT_ENOUGH_RELEASED|20%/)

    // One claim expires, releasing half the budget.
    await expire(first.id)
    expect(await reopen(campaign.id)).toBe('FILLING')

    // Only once, ever.
    await exhaust(campaign.id)
    await expect(reopen(campaign.id)).rejects.toThrow(/ALREADY_REOPENED|already reopened/)
  })
})

describe('reconcile and close', () => {
  it('refuses to reconcile while placements are still open', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()
    await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })

    await exhaust(campaign.id)
    await expect(reconcile(campaign.id)).rejects.toThrow(/OPEN_PLACEMENTS|still open/)
  })

  it('closes with a refund and with a rollover', async () => {
    for (const mode of ['refund', 'rollover'] as const) {
      const brand = await makeBrand()
      const campaign = await makeCampaign({ brandId: brand.id, budgetOre: sek(5_000), fundOre: sek(5_000) })

      await exhaust(campaign.id)
      await reconcile(campaign.id)
      const { returnedOre } = await close(campaign.id, { mode })

      expect(returnedOre).toBe(sek(5_000))

      const balance = await campaignBalance(db, campaign.id)
      expect(balance.availableOre).toBe(0)
      if (mode === 'refund') expect(balance.refundedOre).toBe(sek(5_000))
      else expect(balance.rolledOverOre).toBe(sek(5_000))
      expect(reconciles(balance)).toBe(true)
    }
  })

  it('opens a 7-day dispute window at reconciliation', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    await exhaust(campaign.id)
    await reconcile(campaign.id)

    const after = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })
    expect(after.disputeWindowEndsAt).not.toBeNull()
    const days = (after.disputeWindowEndsAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })

  it('makes a closed campaign read-only', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    await exhaust(campaign.id)
    await reconcile(campaign.id)
    await close(campaign.id, { mode: 'refund' })

    await expect(pause(campaign.id, 'too late', BRAND)).rejects.toThrow(TransitionError)
    await expect(goLive(campaign.id)).rejects.toThrow(TransitionError)
  })
})

describe('fill percent', () => {
  it('counts spent plus reserved against the deposit', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, budgetOre: sek(900), fundOre: sek(900) })

    expect(await fillPercent(campaign.id)).toBe(0)

    const { user, account } = await makeParticipant({ avgViews30d: 450 })
    await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })

    // 90 kr reserved of 900 kr = 10%.
    expect(await fillPercent(campaign.id)).toBe(10)
  })
})
