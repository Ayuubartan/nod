/**
 * Verification pipeline against the database — docs/09 M3 acceptance criteria.
 *
 * The central assertion here is CLAUDE.md rule 5: a placement without disclosure is
 * REJECTED and there is no ops override. The test proves that by showing the pipeline
 * exposes no parameter that can skip check 2, whoever the actor is.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, makeBrand, makeCampaign, makeParticipant, resetDb } from '../helpers/db'
import { campaignBalance, reconciles, walletBalance } from '@/lib/money/balances'
import { sek } from '@/lib/money/calc'
import { LIMITS } from '@/lib/money/rates'
import {
  brandApprove,
  claim,
  generationDone,
  holdEnded,
  participantApprove,
  position,
  publish,
  startGeneration,
  upload,
} from '@/lib/state/placement'
import { clearFlagAndQualify, confirmFraud, holdRecheck, verify } from '@/lib/state/verification'
import { assessFraud } from '@/lib/fraud'
import { disclosurePresent, similarity } from '@/lib/media'

const PARTICIPANT = { kind: 'PARTICIPANT' as const, id: 'p' }
const BRAND = { kind: 'BRAND' as const, id: 'b' }
const OPS = { kind: 'OPS' as const, id: 'ops-1' }

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

const HASH = 'a1b2c3d4e5f60718'

async function drivePublished(options: { avgViews30d?: number; contentType?: 'story' | 'reel' } = {}) {
  const brand = await makeBrand()
  const campaign = await makeCampaign({ brandId: brand.id })
  const { user, account } = await makeParticipant({ avgViews30d: options.avgViews30d ?? 450 })

  const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
  await upload(
    { placementId: claimed.id, storagePath: 'o.jpg', perceptualHash: HASH, contentType: options.contentType ?? 'story' },
    PARTICIPANT,
  )
  await position(claimed.id, { region: { x: 0, y: 0, w: 0.2, h: 0.2 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
  await startGeneration(claimed.id)
  await generationDone(claimed.id, { storagePath: 'v.jpg', engine: 'fake' })
  await participantApprove(claimed.id, PARTICIPANT)
  await brandApprove(claimed.id, BRAND)
  await publish(claimed.id, { postUrl: 'https://instagram.com/p/x', postPlatformId: 'ig_media_1' }, PARTICIPANT)

  return { brand, campaign, user, account, placementId: claimed.id }
}

const goodCaption = 'Reklam – i samarbete med Kaffeklubben\n\nMorgonkaffet på stan ☕'

describe('check 2 — disclosure is a payable condition (CLAUDE.md rule 5)', () => {
  it('rejects a post with no disclosure, whoever runs the verification', async () => {
    const { campaign, placementId } = await drivePublished()
    await holdEnded(placementId)

    const outcome = await verify(
      {
        placementId,
        observedPlatformUserId: null,
        caption: 'Fint kaffe idag #ad',
        hasPaidPartnershipLabel: false,
        publishedHash: HASH,
        views: 1_000,
        viewsSource: 'api',
        stillLive: false,
      },
      OPS,
    )

    expect(outcome.decision).toBe('REJECTED')
    if (outcome.decision !== 'REJECTED') throw new Error('unreachable')
    expect(outcome.failedCheck).toBe('disclosure')
    expect(outcome.reason).toBe('NO_DISCLOSURE')

    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('REJECTED')
    expect(placement.rejectReason).toBe('NO_DISCLOSURE')

    // Nothing was paid, and the reservation went back to the budget.
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.spentOre).toBe(0)
    expect(balance.reservedOre).toBe(0)
    expect(reconciles(balance)).toBe(true)
  })

  it('offers a 12-hour fix window only while the post is live and inside the hold', async () => {
    const { placementId } = await drivePublished()
    await holdEnded(placementId)

    const outcome = await verify({
      placementId,
      observedPlatformUserId: null,
      caption: 'no disclosure here',
      hasPaidPartnershipLabel: false,
      publishedHash: HASH,
      views: 500,
      viewsSource: 'api',
      stillLive: true,
    })

    expect(outcome.decision).toBe('REJECTED')
    if (outcome.decision !== 'REJECTED') throw new Error('unreachable')
    expect(outcome.fixWindow).toBe(true)

    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.fixWindowEndsAt).not.toBeNull()
    const hours = (placement.fixWindowEndsAt!.getTime() - Date.now()) / (60 * 60 * 1000)
    expect(hours).toBeGreaterThan(11.9)
    expect(hours).toBeLessThan(12.1)
  })

  it('gives no fix window once the post is gone', async () => {
    const { placementId } = await drivePublished()
    await holdEnded(placementId)

    const outcome = await verify({
      placementId,
      observedPlatformUserId: null,
      caption: null,
      hasPaidPartnershipLabel: false,
      publishedHash: HASH,
      views: 500,
      viewsSource: 'api',
      stillLive: false,
    })

    if (outcome.decision !== 'REJECTED') throw new Error('expected rejection')
    expect(outcome.fixWindow).toBe(false)
  })

  it('records a minor strike for a missing disclosure, not a serious one', async () => {
    const { user, placementId } = await drivePublished()
    await holdEnded(placementId)

    await verify({
      placementId,
      observedPlatformUserId: null,
      caption: 'nothing',
      hasPaidPartnershipLabel: false,
      publishedHash: HASH,
      views: 500,
      viewsSource: 'api',
      stillLive: true,
    })

    const strikes = await db.strike.findMany({ where: { userId: user.id } })
    expect(strikes).toHaveLength(1)
    expect(strikes[0]!.severity).toBe('MINOR')
  })
})

describe('check order — stop at the first failure', () => {
  it('fails on the account before looking at the caption', async () => {
    const { placementId } = await drivePublished()
    await holdEnded(placementId)

    const outcome = await verify({
      placementId,
      observedPlatformUserId: 'someone_elses_account',
      caption: goodCaption,
      hasPaidPartnershipLabel: true,
      publishedHash: HASH,
      views: 500,
      viewsSource: 'api',
    })

    if (outcome.decision !== 'REJECTED') throw new Error('expected rejection')
    expect(outcome.failedCheck).toBe('account')
    expect(outcome.reason).toBe('WRONG_ACCOUNT')

    const verification = await db.verification.findUniqueOrThrow({ where: { placementId } })
    expect(verification.accountMatch).toBe(false)
    // Later checks were never reached.
    expect(verification.disclosureOk).toBeNull()
  })

  it('fails on a media mismatch after disclosure passes', async () => {
    const { user, placementId } = await drivePublished()
    await holdEnded(placementId)

    const outcome = await verify({
      placementId,
      observedPlatformUserId: null,
      caption: goodCaption,
      hasPaidPartnershipLabel: true,
      publishedHash: '0000000000000000',
      views: 500,
      viewsSource: 'api',
    })

    if (outcome.decision !== 'REJECTED') throw new Error('expected rejection')
    expect(outcome.failedCheck).toBe('media')

    const strikes = await db.strike.findMany({ where: { userId: user.id } })
    expect(strikes[0]!.severity).toBe('SERIOUS')
  })

  it('sends a screenshot-tier placement to ops when there are no views yet', async () => {
    const { placementId } = await drivePublished()
    await holdEnded(placementId)

    const outcome = await verify({
      placementId,
      observedPlatformUserId: null,
      caption: goodCaption,
      hasPaidPartnershipLabel: null,
      publishedHash: null,
      views: null,
      viewsSource: 'screenshot',
    })

    expect(outcome.decision).toBe('NEEDS_OPS')

    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('VERIFYING')
  })
})

describe('the happy path pays', () => {
  it('qualifies and accrues to the wallet, öre for öre', async () => {
    const { campaign, user, placementId } = await drivePublished({ avgViews30d: 450 })
    await holdEnded(placementId)

    const outcome = await verify({
      placementId,
      observedPlatformUserId: null,
      caption: goodCaption,
      hasPaidPartnershipLabel: true,
      publishedHash: HASH,
      views: 450,
      viewsSource: 'api',
    })

    expect(outcome.decision).toBe('QUALIFIED')
    if (outcome.decision !== 'QUALIFIED') throw new Error('unreachable')
    expect(outcome.qualifiedViews).toBe(450)
    expect(outcome.toUserOre).toBe(4_104)

    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect((await walletBalance(db, wallet.id)).availableOre).toBe(4_104)

    const verification = await db.verification.findUniqueOrThrow({ where: { placementId } })
    expect(verification.accountMatch).toBe(true)
    expect(verification.disclosureOk).toBe(true)
    expect(verification.qualifiedViews).toBe(450)
    expect(verification.fraudScore).not.toBeNull()

    await expect(campaignBalance(db, campaign.id).then(reconciles)).resolves.toBe(true)
  })

  it('records a view snapshot for the bookkeeping trail', async () => {
    const { placementId } = await drivePublished()
    await holdEnded(placementId)

    await verify({
      placementId,
      observedPlatformUserId: null,
      caption: goodCaption,
      hasPaidPartnershipLabel: true,
      publishedHash: HASH,
      views: 812,
      viewsSource: 'api',
    })

    const verification = await db.verification.findUniqueOrThrow({
      where: { placementId },
      include: { snapshots: true },
    })
    expect(verification.snapshots).toHaveLength(1)
    expect(verification.snapshots[0]!.views).toBe(812)
  })
})

describe('edge case 2 — a spike gets flagged, then paid at the cap once cleared', () => {
  it('flags an account doing far more than its baseline', async () => {
    const { placementId } = await drivePublished({ avgViews30d: 300 })
    await holdEnded(placementId)

    const outcome = await verify({
      placementId,
      observedPlatformUserId: null,
      caption: goodCaption,
      hasPaidPartnershipLabel: true,
      publishedHash: HASH,
      views: 8_000,
      viewsSource: 'api',
    })

    expect(outcome.decision).toBe('FLAGGED')

    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('FLAGGED')
  })

  it('pays at the reservation cap when ops clears the flag', async () => {
    const { campaign, placementId } = await drivePublished({ avgViews30d: 300 })
    await holdEnded(placementId)

    await verify({
      placementId,
      observedPlatformUserId: null,
      caption: goodCaption,
      hasPaidPartnershipLabel: true,
      publishedHash: HASH,
      views: 8_000,
      viewsSource: 'api',
    })

    const toUserOre = await clearFlagAndQualify(placementId, OPS)

    // Reservation was 90 kr; the payout is capped there and the participant gets 72%.
    expect(toUserOre).toBe(6_480)

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.spentOre).toBe(sek(90))
    expect(reconciles(balance)).toBe(true)
  })

  it('lets ops confirm fraud instead, which rejects and strikes', async () => {
    const { user, placementId } = await drivePublished({ avgViews30d: 300 })
    await holdEnded(placementId)
    await verify({
      placementId,
      observedPlatformUserId: null,
      caption: goodCaption,
      hasPaidPartnershipLabel: true,
      publishedHash: HASH,
      views: 8_000,
      viewsSource: 'api',
    })

    await confirmFraud(placementId, 'Bought views confirmed', OPS)

    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('REJECTED')
    expect(placement.rejectReason).toBe('FRAUD')

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.state).toBe('SUSPENDED')
  })
})

describe('edge case 5 — hold re-check', () => {
  it('passes when the post is still live', async () => {
    const { placementId } = await drivePublished()
    expect(await holdRecheck(placementId, true)).toBe('ok')
    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('PUBLISHED')
  })

  it('rejects with DELETED_EARLY and a serious strike when the post is gone', async () => {
    const { user, placementId } = await drivePublished({ contentType: 'reel' })
    expect(await holdRecheck(placementId, false)).toBe('rejected')

    const placement = await db.placement.findUniqueOrThrow({ where: { id: placementId } })
    expect(placement.state).toBe('REJECTED')
    expect(placement.rejectReason).toBe('DELETED_EARLY')

    const strikes = await db.strike.findMany({ where: { userId: user.id } })
    expect(strikes[0]!.severity).toBe('SERIOUS')
  })
})

describe('fraud scorer', () => {
  it('does not flag a normal post', () => {
    const result = assessFraud({
      views: 500,
      avgViews30d: 450,
      followers: 820,
      accountAgeDays: 400,
      engagements: 30,
      priorQualified: 5,
      priorFraudRejects: 0,
    })
    expect(result.flagged).toBe(false)
    expect(result.fraudDiscount).toBe(0)
  })

  it('flags a huge spike on a brand-new account with no engagement', () => {
    const result = assessFraud({
      views: 40_000,
      avgViews30d: 300,
      followers: 400,
      accountAgeDays: 5,
      engagements: 2,
      priorQualified: 0,
      priorFraudRejects: 0,
    })
    expect(result.score).toBeGreaterThanOrEqual(LIMITS.fraudFlagThreshold)
    expect(result.flagged).toBe(true)
  })

  it('always flags an account with a prior confirmed fraud rejection', () => {
    const result = assessFraud({
      views: 500,
      avgViews30d: 450,
      followers: 820,
      accountAgeDays: 900,
      engagements: 50,
      priorQualified: 10,
      priorFraudRejects: 1,
    })
    const history = result.factors.find((f) => f.name === 'history')
    expect(history?.score).toBe(1)
  })

  it('explains every factor so ops can defend the decision', () => {
    const result = assessFraud({
      views: 1_000,
      avgViews30d: 500,
      followers: 900,
      accountAgeDays: 100,
      engagements: 20,
      priorQualified: 1,
      priorFraudRejects: 0,
    })
    expect(result.factors.map((f) => f.name)).toEqual([
      'velocity', 'reach_vs_followers', 'account_age', 'engagement', 'history',
    ])
    for (const factor of result.factors) {
      expect(factor.detail.length).toBeGreaterThan(0)
      expect(factor.score).toBeGreaterThanOrEqual(0)
      expect(factor.score).toBeLessThanOrEqual(1)
    }
  })

  it('never penalises an unknown geo', () => {
    const result = assessFraud({
      views: 500, avgViews30d: 450, followers: 820, accountAgeDays: 400,
      priorQualified: 3, priorFraudRejects: 0, geoMatch: null,
    })
    expect(result.geoFactor).toBe(1)
  })
})

describe('disclosure detection', () => {
  it('accepts the issued text at the top of the caption', () => {
    expect(disclosurePresent(goodCaption, 'Reklam – i samarbete med Kaffeklubben')).toBe(true)
  })

  it('accepts a bare Reklam or Annons lead', () => {
    expect(disclosurePresent('Reklam för Kaffeklubben', 'anything')).toBe(true)
    expect(disclosurePresent('Annons: nytt kaffe', 'anything')).toBe(true)
    expect(disclosurePresent('Ad – in partnership with X', 'anything')).toBe(true)
  })

  it('rejects disclosure buried in hashtags or absent entirely', () => {
    expect(disclosurePresent('Kaffe på stan\n#kaffe #ad #sthlm', 'Reklam')).toBe(false)
    expect(disclosurePresent('Fint väder', 'Reklam')).toBe(false)
    expect(disclosurePresent(null, 'Reklam')).toBe(false)
    expect(disclosurePresent('', 'Reklam')).toBe(false)
  })
})

describe('perceptual hash similarity', () => {
  it('is 1 for identical hashes and low for unrelated ones', () => {
    expect(similarity(HASH, HASH)).toBe(1)
    expect(similarity('0000000000000000', 'ffffffffffffffff')).toBe(0)
  })

  it('stays above the match threshold for a small difference', () => {
    expect(similarity('a1b2c3d4e5f60718', 'a1b2c3d4e5f60719')).toBeGreaterThan(LIMITS.mediaMatchThreshold)
  })
})
