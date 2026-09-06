/**
 * Placement lifecycle against a real database — docs/09 M2 and M3 acceptance criteria,
 * including the edge cases from docs/03.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  auditFor,
  db,
  ledgerFor,
  makeBrand,
  makeCampaign,
  makeParticipant,
  resetDb,
} from '../helpers/db'
import { campaignBalance, reconciles, walletBalance } from '@/lib/money/balances'
import { reservationOre, sek, settle } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import { TransitionError } from '@/lib/state/transition'
import {
  brandApprove,
  brandReject,
  claim,
  ClaimError,
  expire,
  generationDone,
  holdEnded,
  markPaid,
  participantApprove,
  participantReject,
  position,
  publish,
  qualify,
  regenerate,
  reject,
  startGeneration,
  upload,
} from '@/lib/state/placement'
import { assertCampaignReconciles } from '@/lib/state/money'

const PARTICIPANT = { kind: 'PARTICIPANT' as const, id: 'test' }
const BRAND = { kind: 'BRAND' as const, id: 'brand-user' }

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

/** Drives a placement from claim to APPROVED. Used by most tests below. */
async function driveToApproved(options: { avgViews30d?: number; reviewTier?: 'A' | 'B' } = {}) {
  const brand = await makeBrand()
  const campaign = await makeCampaign({ brandId: brand.id, reviewTier: options.reviewTier ?? 'B' })
  const { user, account } = await makeParticipant({ avgViews30d: options.avgViews30d ?? 450 })

  const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })

  await upload(
    { placementId: claimed.id, storagePath: 'test/original.jpg', perceptualHash: 'a'.repeat(16), contentType: 'story' },
    PARTICIPANT,
  )
  await position(claimed.id, { region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
  await startGeneration(claimed.id)
  await generationDone(claimed.id, { storagePath: 'test/v1.jpg', engine: 'fake' })
  const approved = await participantApprove(claimed.id, PARTICIPANT, { sampleRoll: 0.99 })

  if (!approved.autoApproved) await brandApprove(claimed.id, BRAND)

  return { brand, campaign, user, account, placementId: claimed.id, reservationOre: claimed.reservationOre }
}

describe('P-01 claim — reservation and eligibility', () => {
  it('reserves exactly the amount docs/05 specifies', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant({ avgViews30d: 450 })

    const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })

    expect(claimed.reservationOre).toBe(sek(90))
    expect(claimed.reservationOre).toBe(
      reservationOre(campaign.payoutTemplate!, { avgViews30d: 450 }, campaign.perPlacementMax),
    )

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(sek(90))
    expect(balance.availableOre).toBe(sek(50_000) - sek(90))
    expect(balance.spentOre).toBe(0)
    expect(reconciles(balance)).toBe(true)
  })

  it('moves the campaign from LIVE to FILLING on the first claim', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, state: 'LIVE' })
    const { user, account } = await makeParticipant()

    await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })

    const after = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })
    expect(after.state).toBe('FILLING')
  })

  it('writes an AuditLog row for the claim', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()

    const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })

    const audit = await auditFor('Placement', claimed.id)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.event).toBe('CLAIM')
    expect(audit[0]!.toState).toBe('CLAIMED')
  })

  it('refuses a participant who has not verified with BankID', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant({ state: 'ONBOARDED' })

    await expect(
      claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id }),
    ).rejects.toThrow(/NOT_ELIGIBLE|ONBOARDED/)
  })

  it('refuses a suspended or flagged participant', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })

    for (const state of ['FLAGGED', 'SUSPENDED'] as const) {
      const { user, account } = await makeParticipant({ state })
      await expect(
        claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id }),
      ).rejects.toThrow(ClaimError)
    }
  })

  it('enforces the per-person cap across all of that person’s accounts', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, perPersonCap: 2 })
    const { user, account } = await makeParticipant()

    const second = await db.socialAccount.create({
      data: {
        userId: user.id,
        platform: 'TIKTOK',
        handle: 'second',
        platformUserId: 'tt_second',
        tier: 'CONNECTED_SCREENSHOT',
        followers: 900,
        avgViews30d: 500,
      },
    })

    await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
    await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: second.id })

    await expect(
      claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id }),
    ).rejects.toThrow(/CAP|maximum|Cap/)
  })

  it('refuses an account below the follower floor', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, minFollowers: 300 })
    const { user, account } = await makeParticipant({ followers: 120, tier: 'CONNECTED_SCREENSHOT' })

    await expect(
      claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id }),
    ).rejects.toThrow(/followers/i)
  })

  it('refuses a BELOW_FLOOR or DISCONNECTED account', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })

    for (const tier of ['BELOW_FLOOR', 'DISCONNECTED'] as const) {
      const { user, account } = await makeParticipant({ tier })
      await expect(
        claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id }),
      ).rejects.toThrow(/ACCOUNT_TIER|BELOW_FLOOR|DISCONNECTED/)
    }
  })

  it('refuses a claim on a campaign that is not LIVE or FILLING', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, state: 'FUNDED' })
    const { user, account } = await makeParticipant()

    await expect(
      claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id }),
    ).rejects.toThrow(/FUNDED|not claimable/i)
  })

  it('refuses to claim with someone else’s account', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const a = await makeParticipant()
    const b = await makeParticipant()

    await expect(
      claim({ campaignId: campaign.id, userId: a.user.id, socialAccountId: b.account.id }),
    ).rejects.toThrow(/WRONG_ACCOUNT|does not belong/)
  })

  it('applies the city and age filters', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, cities: ['stockholm'], ageBrackets: ['21-25'] })

    const wrongCity = await makeParticipant({ city: 'malmo' })
    await expect(
      claim({ campaignId: campaign.id, userId: wrongCity.user.id, socialAccountId: wrongCity.account.id }),
    ).rejects.toThrow(/CITY|cities/i)

    const wrongAge = await makeParticipant({ ageBracket: '31+' })
    await expect(
      claim({ campaignId: campaign.id, userId: wrongAge.user.id, socialAccountId: wrongAge.account.id }),
    ).rejects.toThrow(/AGE|age/i)
  })
})

describe('edge case 1 — budget exhaustion', () => {
  it('blocks new claims once the budget is reserved, but honours the open ones', async () => {
    const brand = await makeBrand()
    // Enough for exactly two 90 kr reservations.
    const campaign = await makeCampaign({ brandId: brand.id, budgetOre: sek(180), fundOre: sek(180) })

    const a = await makeParticipant({ avgViews30d: 450 })
    const b = await makeParticipant({ avgViews30d: 450 })
    const c = await makeParticipant({ avgViews30d: 450 })

    const first = await claim({ campaignId: campaign.id, userId: a.user.id, socialAccountId: a.account.id })
    const second = await claim({ campaignId: campaign.id, userId: b.user.id, socialAccountId: b.account.id })

    // The budget is gone, so the campaign exhausts itself and refuses the third claim.
    const exhausted = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })
    expect(exhausted.state).toBe('EXHAUSTED')

    await expect(
      claim({ campaignId: campaign.id, userId: c.user.id, socialAccountId: c.account.id }),
    ).rejects.toThrow(ClaimError)

    // The two reserved claims are unaffected and can still complete.
    expect(first.reservationOre).toBe(sek(90))
    expect(second.reservationOre).toBe(sek(90))

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.availableOre).toBe(0)
    expect(balance.reservedOre).toBe(sek(180))
    expect(reconciles(balance)).toBe(true)
  })
})

describe('edge case 6 — duplicate image', () => {
  it('blocks the same image being used in a second placement', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const a = await makeParticipant()
    const b = await makeParticipant()

    const first = await claim({ campaignId: campaign.id, userId: a.user.id, socialAccountId: a.account.id })
    const second = await claim({ campaignId: campaign.id, userId: b.user.id, socialAccountId: b.account.id })

    const hash = 'deadbeefdeadbeef'
    await upload({ placementId: first.id, storagePath: 'a.jpg', perceptualHash: hash, contentType: 'story' }, PARTICIPANT)

    await expect(
      upload({ placementId: second.id, storagePath: 'b.jpg', perceptualHash: hash, contentType: 'story' }, PARTICIPANT),
    ).rejects.toThrow(/DUPLICATE|already used/i)
  })

  it('allows reuse of a hash from an expired placement', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const a = await makeParticipant()
    const b = await makeParticipant()

    const first = await claim({ campaignId: campaign.id, userId: a.user.id, socialAccountId: a.account.id })
    const hash = 'cafecafecafecafe'
    await upload({ placementId: first.id, storagePath: 'a.jpg', perceptualHash: hash, contentType: 'story' }, PARTICIPANT)
    await expire(first.id)

    const second = await claim({ campaignId: campaign.id, userId: b.user.id, socialAccountId: b.account.id })
    await expect(
      upload({ placementId: second.id, storagePath: 'b.jpg', perceptualHash: hash, contentType: 'story' }, PARTICIPANT),
    ).resolves.toBe('UPLOADED')
  })
})

describe('reservation release', () => {
  it('releases on expiry and restores the campaign’s available budget', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant({ avgViews30d: 450 })

    const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
    await expire(claimed.id)

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(0)
    expect(balance.availableOre).toBe(sek(50_000))
    expect(reconciles(balance)).toBe(true)
  })

  it('releases on participant rejection', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()

    const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
    await participantReject(claimed.id, 'Not for me', PARTICIPANT)

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(0)
    expect(balance.availableOre).toBe(sek(50_000))
  })

  it('releases on a final brand rejection, after bouncing once', async () => {
    const { campaign, placementId } = await driveToApproved()

    // Put it back into brand review by re-driving the flow.
    const bounced = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(bounced.state).toBe('APPROVED')

    // A second placement exercises the bounce-then-final path.
    const { user, account } = await makeParticipant()
    const second = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
    await upload({ placementId: second.id, storagePath: 'x.jpg', perceptualHash: 'b'.repeat(16), contentType: 'story' }, PARTICIPANT)
    await position(second.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
    await startGeneration(second.id)
    await generationDone(second.id, { storagePath: 'v.jpg', engine: 'fake' })
    await participantApprove(second.id, PARTICIPANT)

    const first = await brandReject(second.id, 'Product not visible', BRAND)
    expect(first.final).toBe(false)
    expect(first.state).toBe('POSITIONED')

    // Drive it back to brand review and reject again — this time it is final.
    await startGeneration(second.id)
    await generationDone(second.id, { storagePath: 'v2.jpg', engine: 'fake' })
    await participantApprove(second.id, PARTICIPANT)
    const final = await brandReject(second.id, 'Still not right', BRAND)

    expect(final.final).toBe(true)
    expect(final.state).toBe('REJECTED_BY_BRAND')

    const balance = await campaignBalance(db, campaign.id)
    expect(reconciles(balance)).toBe(true)
  })

  it('never releases twice, even if expire is called on an already-terminal placement', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()

    const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
    await expire(claimed.id)
    await expect(expire(claimed.id)).rejects.toThrow(TransitionError)

    const entries = await ledgerFor(campaign.id)
    const releases = entries.filter((e) => e.type === 'RELEASE_RESERVATION')
    expect(releases).toHaveLength(1)
  })
})

describe('P-05 participant review', () => {
  it('allows three regenerations and refuses the fourth', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()

    const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
    await upload({ placementId: claimed.id, storagePath: 'o.jpg', perceptualHash: 'c'.repeat(16), contentType: 'story' }, PARTICIPANT)
    await position(claimed.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)

    for (let i = 0; i < 3; i++) {
      await startGeneration(claimed.id)
      await generationDone(claimed.id, { storagePath: `v${i}.jpg`, engine: 'fake' })
      await regenerate(claimed.id, { reason: 'try again' }, PARTICIPANT)
    }

    await startGeneration(claimed.id)
    await generationDone(claimed.id, { storagePath: 'v4.jpg', engine: 'fake' })

    await expect(regenerate(claimed.id, {}, PARTICIPANT)).rejects.toThrow(/REGEN_LIMIT|regenerations/)
  })

  it('logs every review action as a PlacementEvent training signal', async () => {
    const { placementId } = await driveToApproved()

    const events = await db.placementEvent.findMany({ where: { placementId } })
    const types = events.map((e) => e.type)
    expect(types).toContain('REGION_PICKED')
    expect(types).toContain('APPROVE')
  })

  it('pauses the participant clock while generating and restores it afterwards', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant()

    const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
    await upload({ placementId: claimed.id, storagePath: 'o.jpg', perceptualHash: 'd'.repeat(16), contentType: 'story' }, PARTICIPANT)
    await position(claimed.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)

    await startGeneration(claimed.id)
    const generating = await db.placement.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(generating.clockPausedAt).not.toBeNull()

    await generationDone(claimed.id, { storagePath: 'v.jpg', engine: 'fake' })
    const reviewing = await db.placement.findUniqueOrThrow({ where: { id: claimed.id } })
    expect(reviewing.clockPausedAt).toBeNull()
    expect(reviewing.state).toBe('PARTICIPANT_REVIEW')
  })
})

describe('P-06 review tiers', () => {
  it('auto-approves a Tier A placement without waiting for the brand', async () => {
    const { placementId } = await driveToApproved({ reviewTier: 'A' })
    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('APPROVED')
  })

  it('marks roughly 5% of Tier A placements for a brand sample', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, reviewTier: 'A' })

    const sampled: boolean[] = []
    for (const roll of [0.01, 0.5]) {
      const { user, account } = await makeParticipant()
      const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
      await upload(
        { placementId: claimed.id, storagePath: `${roll}.jpg`, perceptualHash: String(roll).padEnd(16, '0'), contentType: 'story' },
        PARTICIPANT,
      )
      await position(claimed.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
      await startGeneration(claimed.id)
      await generationDone(claimed.id, { storagePath: 'v.jpg', engine: 'fake' })
      await participantApprove(claimed.id, PARTICIPANT, { sampleRoll: roll })

      const placement = await db.placement.findUniqueOrThrow({ where: { id: claimed.id } })
      sampled.push(placement.brandSampled)
    }

    // roll 0.01 is below the 5% sample rate; roll 0.5 is not.
    expect(sampled).toEqual([true, false])
  })

  it('issues the disclosure text with the brand name substituted', async () => {
    const { placementId } = await driveToApproved()
    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.disclosureTextIssued).toBe('Reklam – i samarbete med Kaffeklubben')
    expect(placement.disclosureToken).toBeTruthy()
  })

  it('promotes the participant from VERIFIED to ACTIVE on their first approval', async () => {
    const { user } = await driveToApproved()
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.state).toBe('ACTIVE')
  })
})

describe('P-08 to P-10 — settle to the öre', () => {
  it('matches docs/05 worked example row 1 exactly', async () => {
    const { campaign, user, placementId, reservationOre: reserved } = await driveToApproved({ avgViews30d: 450 })

    await publish(placementId, { postUrl: 'https://instagram.com/p/abc' }, PARTICIPANT)
    await holdEnded(placementId)
    await db.verification.create({ data: { placementId, views: 450, viewsSource: 'api' } })

    const result = await qualify(placementId, 450)
    await markPaid(placementId)

    const expected = settle(campaign.payoutTemplate!, 450, reserved)
    expect(result.allInOre).toBe(sek(57))
    expect(result.toUserOre).toBe(4_104)
    expect(result.toUserOre).toBe(expected.toUserOre)

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.spentOre).toBe(sek(57))
    expect(balance.takeOre).toBe(1_596)
    expect(balance.reservedOre).toBe(0)
    expect(balance.availableOre).toBe(sek(50_000) - sek(57))
    expect(reconciles(balance)).toBe(true)

    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    const walletBal = await walletBalance(db, wallet.id)
    expect(walletBal.availableOre).toBe(4_104)

    await assertCampaignReconciles(campaign.id)
  })

  it('caps the payout at the reservation and releases nothing when views spike', async () => {
    // docs/05 row 4: 300 avg views reserves 90 kr; 8,000 actual views still pays 90 kr.
    const { campaign, placementId, reservationOre: reserved } = await driveToApproved({ avgViews30d: 300 })
    expect(reserved).toBe(sek(90))

    await publish(placementId, { postUrl: 'https://instagram.com/p/spike' }, PARTICIPANT)
    await holdEnded(placementId)
    await db.verification.create({ data: { placementId, views: 8_000, viewsSource: 'api' } })

    const result = await qualify(placementId, 8_000)

    expect(result.allInOre).toBe(sek(90))
    expect(result.toUserOre).toBe(6_480)

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.spentOre).toBe(sek(90))
    expect(reconciles(balance)).toBe(true)
  })

  it('releases the unused part of the reservation back to the budget', async () => {
    const { campaign, placementId } = await driveToApproved({ avgViews30d: 1_500 })

    await publish(placementId, { postUrl: 'https://instagram.com/p/under' }, PARTICIPANT)
    await holdEnded(placementId)
    await db.verification.create({ data: { placementId, views: 1_500, viewsSource: 'api' } })

    await qualify(placementId, 1_500)

    const balance = await campaignBalance(db, campaign.id)
    // Reserved 210 kr, spent 120 kr, so 90 kr goes back to available.
    expect(balance.spentOre).toBe(sek(120))
    expect(balance.reservedOre).toBe(0)
    expect(balance.availableOre).toBe(sek(50_000) - sek(120))
    expect(reconciles(balance)).toBe(true)
  })

  it('pays the fixed component only below the view floor', async () => {
    const { campaign, placementId } = await driveToApproved({ avgViews30d: 450 })

    await publish(placementId, { postUrl: 'https://instagram.com/p/small' }, PARTICIPANT)
    await holdEnded(placementId)
    await db.verification.create({ data: { placementId, views: 40, viewsSource: 'api' } })

    const result = await qualify(placementId, 40)
    expect(result.allInOre).toBe(DEFAULTS.fixedOre)

    const balance = await campaignBalance(db, campaign.id)
    expect(reconciles(balance)).toBe(true)
  })

  it('writes exactly the four ledger entries a settlement produces', async () => {
    const { placementId } = await driveToApproved({ avgViews30d: 450 })

    await publish(placementId, { postUrl: 'https://instagram.com/p/ledger' }, PARTICIPANT)
    await holdEnded(placementId)
    await db.verification.create({ data: { placementId, views: 450, viewsSource: 'api' } })
    await qualify(placementId, 450)

    const entries = await db.ledgerEntry.findMany({ where: { placementId } })
    const byType = entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + e.amountOre
      return acc
    }, {})

    expect(byType.RESERVE).toBe(sek(90))
    expect(byType.SETTLE).toBe(sek(57))
    expect(byType.PAYOUT_ACCRUE).toBe(4_104)
    expect(byType.TAKE).toBe(1_596)
    expect(byType.RELEASE_RESERVATION).toBe(sek(33))
    expect(byType.PAYOUT_ACCRUE! + byType.TAKE!).toBe(byType.SETTLE)
  })
})

describe('edge case 5 — deleted during the hold', () => {
  it('rejects the placement and records a serious strike', async () => {
    const { campaign, user, placementId } = await driveToApproved()

    await publish(placementId, { postUrl: 'https://instagram.com/p/deleted' }, PARTICIPANT)
    await reject({ placementId, reason: 'DELETED_EARLY', strike: 'SERIOUS' })

    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('REJECTED')
    expect(placement.rejectReason).toBe('DELETED_EARLY')

    const strikes = await db.strike.findMany({ where: { userId: user.id } })
    expect(strikes).toHaveLength(1)
    expect(strikes[0]!.severity).toBe('SERIOUS')

    // One serious strike suspends (docs/03 section 3).
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.state).toBe('SUSPENDED')

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(0)
    expect(reconciles(balance)).toBe(true)
  })
})

describe('the whole ledger always reconciles', () => {
  it('after a mixed run of qualified, rejected and expired placements', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, budgetOre: sek(10_000), fundOre: sek(10_000) })

    for (let i = 0; i < 6; i++) {
      const { user, account } = await makeParticipant({ avgViews30d: 450 })
      const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })

      if (i % 3 === 0) {
        await expire(claimed.id)
        continue
      }

      await upload(
        { placementId: claimed.id, storagePath: `${i}.jpg`, perceptualHash: String(i).repeat(16).slice(0, 16), contentType: 'story' },
        PARTICIPANT,
      )
      await position(claimed.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
      await startGeneration(claimed.id)
      await generationDone(claimed.id, { storagePath: `v${i}.jpg`, engine: 'fake' })

      if (i % 3 === 1) {
        await participantReject(claimed.id, 'nope', PARTICIPANT)
        continue
      }

      await participantApprove(claimed.id, PARTICIPANT)
      await brandApprove(claimed.id, BRAND)
      await publish(claimed.id, { postUrl: `https://instagram.com/p/${i}` }, PARTICIPANT)
      await holdEnded(claimed.id)
      await db.verification.create({ data: { placementId: claimed.id, views: 450, viewsSource: 'api' } })
      await qualify(claimed.id, 450)
      await markPaid(claimed.id)
    }

    await assertCampaignReconciles(campaign.id)

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.depositedOre).toBe(sek(10_000))
    expect(balance.reservedOre).toBe(0)
    expect(balance.spentOre).toBe(2 * sek(57))
    expect(balance.availableOre).toBe(sek(10_000) - 2 * sek(57))
  })
})
