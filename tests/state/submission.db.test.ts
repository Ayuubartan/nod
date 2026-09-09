/**
 * Clip campaigns against a real database — docs/14 §2 (membership, submission), D2
 * (reserve at submission, first-validated wins) and §5 (settlement).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { auditFor, db, ledgerFor, makeBrand, makeCampaign, makeParticipant, resetDb } from '../helpers/db'
import { campaignBalance, reconciles, walletBalance } from '@/lib/money/balances'
import { sek } from '@/lib/money/calc'
import { settleRef } from '@/lib/money/ledger'
import { clearCapturedEvents, eventsOfType } from '@/lib/events'
import { TransitionError } from '@/lib/state/transition'
import { joinCampaign, JoinError, leaveCampaign } from '@/lib/state/membership'
import {
  dueForTracking,
  holdSubmission,
  needsDisclosureFix,
  qualifySubmission,
  recordMissing,
  recordObservation,
  rejectSubmission,
  startValidating,
  SubmitError,
  submitPost,
  validationsDue,
  verificationPassed,
} from '@/lib/state/submission'
import { markQualifiedAsPaid } from '@/lib/state/money'

const PARTICIPANT = { kind: 'PARTICIPANT' as const, id: 'test' }
const OPS = { kind: 'OPS' as const, id: 'ops' }
const HOUR = 60 * 60 * 1000

beforeEach(async () => {
  await resetDb()
  clearCapturedEvents()
})
afterAll(async () => {
  await db.$disconnect()
})

let urlCounter = 0
const ttUrl = () => `https://www.tiktok.com/@creator/video/72345678901234${String(urlCounter++).padStart(5, '0')}`
const igUrl = () => `https://www.instagram.com/reel/C1a2B3c4D${String(urlCounter++).padStart(2, '0')}/`

/** A CLIP campaign: 1 000 kr budget, 400 kr per post, pure CPM at 60 kr / 1 000 views. */
async function makeClipCampaign(overrides: Partial<Parameters<typeof makeCampaign>[0]> = {}) {
  const brand = await makeBrand()
  return makeCampaign({
    brandId: brand.id,
    kind: 'CLIP',
    templateKind: 'CPM',
    fixedOre: 0,
    cpmOre: sek(60),
    viewFloor: 100,
    budgetOre: sek(1_000),
    perPlacementMaxOre: sek(400),
    perPersonCap: 10,
    requiredHashtags: ['#kaffeklubben'],
    ...overrides,
  })
}

async function joinedCreator(campaignId: string, args: Parameters<typeof makeParticipant>[0] = {}) {
  const { user, account } = await makeParticipant({ platform: 'TIKTOK', ...args })
  const membership = await joinCampaign({ campaignId, userId: user.id })
  return { user, account, membership }
}

async function tracked(campaignId: string, userId: string, initialViews = 100) {
  const s = await submitPost({ campaignId, userId, url: ttUrl() })
  await db.submission.update({ where: { id: s.id }, data: { providerMediaId: s.postId } })
  await verificationPassed({
    submissionId: s.id,
    caption: '#reklam #kaffeklubben',
    publishedAt: new Date(Date.now() - HOUR),
    initial: { views: initialViews },
  })
  return s
}

// ---------------------------------------------------------------- membership

describe('joinCampaign — docs/14 §2, D5, D7', () => {
  it('creates a seat, audits it and emits membership/joined; a second join is idempotent', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await makeParticipant({ platform: 'TIKTOK' })

    const first = await joinCampaign({ campaignId: campaign.id, userId: user.id })
    expect(first.created).toBe(true)
    const again = await joinCampaign({ campaignId: campaign.id, userId: user.id })
    expect(again).toEqual({ id: first.id, created: false })

    const audit = await auditFor('CampaignMembership', first.id)
    expect(audit.map((a) => a.event)).toEqual(['JOIN'])
    expect(eventsOfType('membership/joined')).toHaveLength(1)
    expect(await db.campaignMembership.count({ where: { campaignId: campaign.id } })).toBe(1)
  })

  it('needs an API-connected account on a campaign platform inside the follower band', async () => {
    const campaign = await makeClipCampaign({ platforms: ['TIKTOK'], minFollowers: 500 })

    const screenshot = await makeParticipant({ platform: 'TIKTOK', tier: 'CONNECTED_SCREENSHOT' })
    await expect(joinCampaign({ campaignId: campaign.id, userId: screenshot.user.id })).rejects.toMatchObject({ code: 'NO_CONNECTED_ACCOUNT' })

    const instagramOnly = await makeParticipant({ platform: 'INSTAGRAM' })
    await expect(joinCampaign({ campaignId: campaign.id, userId: instagramOnly.user.id })).rejects.toMatchObject({ code: 'NO_CONNECTED_ACCOUNT' })

    const small = await makeParticipant({ platform: 'TIKTOK', followers: 200 })
    await expect(joinCampaign({ campaignId: campaign.id, userId: small.user.id })).rejects.toBeInstanceOf(JoinError)
    await expect(joinCampaign({ campaignId: campaign.id, userId: small.user.id })).rejects.toMatchObject({ code: 'FOLLOWERS' })

    const notVerified = await makeParticipant({ platform: 'TIKTOK', state: 'ONBOARDED' })
    await expect(joinCampaign({ campaignId: campaign.id, userId: notVerified.user.id })).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' })
  })

  it('refuses placement campaigns, paused joins and full campaigns', async () => {
    const brand = await makeBrand()
    const placement = await makeCampaign({ brandId: brand.id })
    const { user } = await makeParticipant({ platform: 'TIKTOK' })
    await expect(joinCampaign({ campaignId: placement.id, userId: user.id })).rejects.toMatchObject({ code: 'NOT_CLIP' })

    const capped = await makeClipCampaign({ joinCap: 1 })
    await joinCampaign({ campaignId: capped.id, userId: user.id })
    const other = await makeParticipant({ platform: 'TIKTOK' })
    await expect(joinCampaign({ campaignId: capped.id, userId: other.user.id })).rejects.toMatchObject({ code: 'FULL' })

    await db.campaign.update({ where: { id: capped.id }, data: { joinsPausedAt: new Date(), joinCap: null } })
    await expect(joinCampaign({ campaignId: capped.id, userId: other.user.id })).rejects.toMatchObject({ code: 'JOINS_PAUSED' })
  })

  it('leave then rejoin reuses the row through the state machine', async () => {
    const campaign = await makeClipCampaign({ joinCap: 1 })
    const { user, membership } = await joinedCreator(campaign.id)

    expect(await leaveCampaign(membership.id, PARTICIPANT)).toBe('LEFT')
    // The seat is free while they are out.
    const other = await makeParticipant({ platform: 'TIKTOK' })
    await joinCampaign({ campaignId: campaign.id, userId: other.user.id })
    await expect(joinCampaign({ campaignId: campaign.id, userId: user.id })).rejects.toMatchObject({ code: 'FULL' })

    await db.campaign.update({ where: { id: campaign.id }, data: { joinCap: 2 } })
    const back = await joinCampaign({ campaignId: campaign.id, userId: user.id })
    expect(back).toEqual({ id: membership.id, created: false })
    const row = await db.campaignMembership.findUniqueOrThrow({ where: { id: membership.id } })
    expect(row.state).toBe('JOINED')
    expect(row.leftAt).toBeNull()
    expect((await auditFor('CampaignMembership', membership.id)).map((a) => a.event)).toEqual(['JOIN', 'LEAVE', 'REJOIN'])
  })
})

// ---------------------------------------------------------------- submit + reservations

describe('submitPost — S-01 and D2 reservations', () => {
  it('reserves the per-post cap from the campaign and moves the campaign to FILLING', async () => {
    const campaign = await makeClipCampaign()
    const { user, account } = await joinedCreator(campaign.id)

    const result = await submitPost({ campaignId: campaign.id, userId: user.id, url: ttUrl() + '?is_from_webapp=1' })
    expect(result).toMatchObject({ reservationOre: sek(400), budgetExhausted: false, platform: 'TIKTOK' })

    const row = await db.submission.findUniqueOrThrow({ where: { id: result.id } })
    expect(row.state).toBe('RECEIVED')
    expect(row.socialAccountId).toBe(account.id)
    expect(row.canonicalUrl).not.toContain('?')

    const ledger = await ledgerFor(campaign.id)
    expect(ledger.map((e) => [e.type, e.amountOre, e.submissionId])).toEqual([
      ['DEPOSIT', sek(1_000), null],
      ['RESERVE', sek(400), result.id],
    ])
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.availableOre).toBe(sek(600))
    expect(balance.reservedOre).toBe(sek(400))
    expect(reconciles(balance)).toBe(true)

    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).state).toBe('FILLING')
    expect((await auditFor('Submission', result.id)).map((a) => a.event)).toEqual(['SUBMIT'])
    expect(eventsOfType('submission/received')).toHaveLength(1)
  })

  it('refuses bad links, other platforms, non-members, duplicates and the per-creator cap', async () => {
    const campaign = await makeClipCampaign({ platforms: ['TIKTOK'], perPersonCap: 2 })
    const { user } = await joinedCreator(campaign.id)
    const submit = (url: string, userId = user.id) => submitPost({ campaignId: campaign.id, userId, url })

    await expect(submit('https://vm.tiktok.com/ZMabc123/')).rejects.toMatchObject({ code: 'URL_SHORT_LINK' })
    await expect(submit('https://youtube.com/watch?v=x')).rejects.toBeInstanceOf(SubmitError)
    await expect(submit(igUrl())).rejects.toMatchObject({ code: 'PLATFORM' })

    const stranger = await makeParticipant({ platform: 'TIKTOK' })
    await expect(submit(ttUrl(), stranger.user.id)).rejects.toMatchObject({ code: 'NOT_JOINED' })

    const url = ttUrl()
    await submit(url)
    await expect(submit(url)).rejects.toMatchObject({ code: 'DUPLICATE' })
    // Same post, different query string — same id.
    await expect(submit(url + '?lang=sv')).rejects.toMatchObject({ code: 'DUPLICATE' })

    await submit(ttUrl())
    await expect(submit(ttUrl())).rejects.toMatchObject({ code: 'CAP' })

    // Nothing was reserved for the refused attempts.
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(sek(800))
    expect(await db.submission.count({ where: { campaignId: campaign.id } })).toBe(2)
  })

  it('reserves the remainder when the budget runs low, then accepts posts as not payable', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const submit = () => submitPost({ campaignId: campaign.id, userId: user.id, url: ttUrl() })

    const a = await submit()
    const b = await submit()
    const c = await submit()
    expect([a.reservationOre, b.reservationOre, c.reservationOre]).toEqual([sek(400), sek(400), sek(200)])
    expect(c.budgetExhausted).toBe(false)
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).state).toBe('EXHAUSTED')

    // D2: still accepted, tracked, marked not payable. No RESERVE row for zero öre.
    const d = await submit()
    expect(d).toMatchObject({ reservationOre: 0, budgetExhausted: true })
    const ledger = await ledgerFor(campaign.id)
    expect(ledger.filter((e) => e.type === 'RESERVE')).toHaveLength(3)
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.availableOre).toBe(0)
    expect(reconciles(balance)).toBe(true)

    // Joining an exhausted campaign is still allowed — the creator may post for free reach.
    const late = await makeParticipant({ platform: 'TIKTOK' })
    await expect(joinCampaign({ campaignId: campaign.id, userId: late.user.id })).resolves.toMatchObject({ created: true })
  })

  it('a rejection releases its reservation and tops up older under-reserved submissions', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const submit = () => submitPost({ campaignId: campaign.id, userId: user.id, url: ttUrl() })
    const a = await submit() // 400
    await submit() // 400
    const c = await submit() // 200
    const d = await submit() // 0, exhausted

    await rejectSubmission({ submissionId: a.id, reason: 'NOT_OWNER' }, OPS)

    const ledger = await ledgerFor(campaign.id)
    const releases = ledger.filter((e) => e.type === 'RELEASE_RESERVATION')
    expect(releases.map((e) => [e.amountOre, e.submissionId])).toEqual([[sek(400), a.id]])
    // 400 freed: c gets 200 to reach its cap, d gets the other 200.
    const cRow = await db.submission.findUniqueOrThrow({ where: { id: c.id } })
    const dRow = await db.submission.findUniqueOrThrow({ where: { id: d.id } })
    expect(cRow.reservationOre).toBe(sek(400))
    expect(dRow).toMatchObject({ reservationOre: sek(200), budgetExhausted: false })
    expect((await auditFor('Submission', d.id)).map((x) => x.event)).toEqual(['SUBMIT', 'RESERVATION_TOP_UP'])

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.availableOre).toBe(0)
    expect(balance.reservedOre).toBe(sek(1_000))
    expect(reconciles(balance)).toBe(true)
    expect(eventsOfType('submission/rejected')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- verification outcomes + tracking

describe('verification outcomes and tracking observations — S-02..S-04', () => {
  it('verificationPassed starts tracking with a baseline snapshot and a validation deadline', async () => {
    const campaign = await makeClipCampaign({ validationHours: 72 })
    const { user } = await joinedCreator(campaign.id)
    const s = await tracked(campaign.id, user.id, 150)

    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id }, include: { snapshots: true } })
    expect(row.state).toBe('TRACKING')
    expect(row.initialViews).toBe(150)
    expect(row.latestViews).toBe(150)
    expect(row.eligibleViews).toBe(0)
    expect(row.validationEndsAt!.getTime()).toBe(row.submittedAt.getTime() + 72 * HOUR)
    expect(row.nextCheckAt).not.toBeNull()
    expect(row.priority).toBe(0)
    expect(row.snapshots).toHaveLength(1)

    expect(await dueForTracking(new Date(Date.now() + 15 * 60 * 1000))).toEqual([
      { id: s.id, platform: 'TIKTOK', socialAccountId: row.socialAccountId },
    ])
    expect(await validationsDue()).toEqual([])
    expect(await validationsDue(new Date(Date.now() + 73 * HOUR))).toEqual([{ id: s.id }])
    expect(eventsOfType('submission/tracking')).toHaveLength(1)
  })

  it('needsDisclosureFix opens a 12 h window, and the fix leads to TRACKING', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const s = await submitPost({ campaignId: campaign.id, userId: user.id, url: ttUrl() })
    const now = new Date()

    await needsDisclosureFix(s.id, { missingHashtags: ['kaffeklubben'], missingMentions: [], disclosureOk: true }, undefined, now)
    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.state).toBe('FIX_DISCLOSURE')
    expect(row.fixWindowEndsAt!.getTime()).toBe(now.getTime() + 12 * HOUR)
    // Still holds its reservation while the creator fixes the caption.
    expect((await campaignBalance(db, campaign.id)).reservedOre).toBe(sek(400))

    await verificationPassed({ submissionId: s.id, caption: '#reklam #kaffeklubben', publishedAt: now, initial: { views: 10 } })
    expect((await db.submission.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('TRACKING')
  })

  it('observations are bucketed, monotonic and flag decreases as risk', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const s = await tracked(campaign.id, user.id, 100)
    // Aligned to a bucket start so the +60 s observation is guaranteed to share it.
    const t0 = new Date(Math.floor((Date.now() + HOUR) / (5 * 60_000)) * 5 * 60_000)

    const first = await recordObservation(s.id, { views: 1_100, likes: 40 }, t0)
    expect(first).toEqual({ recorded: true, decreased: false, eligibleViews: 1_000 })
    // Same 5-minute bucket → no second snapshot row.
    const dup = await recordObservation(s.id, { views: 1_150 }, new Date(t0.getTime() + 60_000))
    expect(dup.recorded).toBe(false)

    const drop = await recordObservation(s.id, { views: 400 }, new Date(t0.getTime() + HOUR))
    expect(drop).toEqual({ recorded: true, decreased: true, eligibleViews: 1_050 })

    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id }, include: { snapshots: true } })
    expect(row.latestViews).toBe(1_150)
    expect(row.riskFactors).toEqual(['views_decreased'])
    expect(row.snapshots).toHaveLength(3)
    expect(row.snapshots.map((x) => x.views).sort((a, b) => a - b)).toEqual([100, 400, 1_100])
    expect(eventsOfType('submission/risk')).toHaveLength(1)
  })

  it('two consecutive misses count, an observation resets them', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const s = await tracked(campaign.id, user.id)

    expect(await recordMissing(s.id)).toBe(1)
    await recordObservation(s.id, { views: 500 }, new Date(Date.now() + HOUR))
    expect(await recordMissing(s.id)).toBe(1)
    expect(await recordMissing(s.id)).toBe(2)
  })
})

// ---------------------------------------------------------------- settlement

describe('settlement — docs/14 §5, first-validated wins', () => {
  it('cannot qualify from TRACKING, and ops cannot pay a tracking post', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const s = await tracked(campaign.id, user.id)
    await expect(qualifySubmission({ submissionId: s.id, qualifiedViews: 1000, riskScore: 5, riskFactors: [] })).rejects.toBeInstanceOf(TransitionError)
    expect((await ledgerFor(campaign.id)).some((e) => e.type === 'SETTLE')).toBe(false)
  })

  it('settles capped by the reservation, splits the take, reconciles, and is idempotent', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const s = await tracked(campaign.id, user.id)
    await startValidating(s.id)

    // 10 000 views × 60 kr CPM = 600 kr, capped by the 400 kr reservation.
    const result = await qualifySubmission({ submissionId: s.id, qualifiedViews: 10_000, riskScore: 12, riskFactors: [] })
    expect(result).toEqual({ state: 'QUALIFIED', toUserOre: 28_800, allInOre: sek(400) })

    const ledger = await ledgerFor(campaign.id)
    const settle = ledger.find((e) => e.type === 'SETTLE')
    expect(settle).toMatchObject({ amountOre: sek(400), submissionId: s.id, externalRef: settleRef(s.id) })
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    expect((await walletBalance(db, wallet.id)).availableOre).toBe(28_800)
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(0)
    expect(balance.spentOre).toBe(sek(400))
    expect(balance.takeOre).toBe(11_200)
    expect(reconciles(balance)).toBe(true)

    // A replayed job is refused by the table and posts nothing twice.
    await expect(qualifySubmission({ submissionId: s.id, qualifiedViews: 10_000, riskScore: 12, riskFactors: [] })).rejects.toBeInstanceOf(TransitionError)
    expect((await ledgerFor(campaign.id)).length).toBe(ledger.length)
    expect(eventsOfType('submission/qualified')).toHaveLength(1)
    expect(eventsOfType('money/payout.accrued')).toHaveLength(1)

    // Payout run marks the submission PAID alongside placements.
    await markQualifiedAsPaid()
    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.state).toBe('PAID')
    expect(row.paidAt).not.toBeNull()
  })

  it('a small result releases the remainder to the next creator in line', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const a = await tracked(campaign.id, user.id) // 400
    await submitPost({ campaignId: campaign.id, userId: user.id, url: ttUrl() }) // 400
    const c = await submitPost({ campaignId: campaign.id, userId: user.id, url: ttUrl() }) // 200
    await startValidating(a.id)

    // 1 000 views → 60 kr all-in; 340 kr released and c is topped up to its cap.
    const result = await qualifySubmission({ submissionId: a.id, qualifiedViews: 1_000, riskScore: 0, riskFactors: [] })
    expect(result.allInOre).toBe(sek(60))
    expect((await db.submission.findUniqueOrThrow({ where: { id: c.id } })).reservationOre).toBe(sek(400))
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.availableOre).toBe(sek(140))
    expect(balance.reservedOre).toBe(sek(800))
    expect(reconciles(balance)).toBe(true)
  })

  it('below the view floor nothing is owed: reservation fully released, no SETTLE row', async () => {
    const campaign = await makeClipCampaign()
    const { user } = await joinedCreator(campaign.id)
    const s = await tracked(campaign.id, user.id)
    await startValidating(s.id)
    const result = await qualifySubmission({ submissionId: s.id, qualifiedViews: 40, riskScore: 0, riskFactors: [] })
    expect(result).toMatchObject({ state: 'QUALIFIED', toUserOre: 0, allInOre: 0 })
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.availableOre).toBe(sek(1_000))
    expect(balance.reservedOre).toBe(0)
    expect(reconciles(balance)).toBe(true)
  })

  it('HELD keeps the reservation until ops decide; a second fraud reject suspends the seat', async () => {
    const campaign = await makeClipCampaign()
    const { user, membership } = await joinedCreator(campaign.id)
    const a = await tracked(campaign.id, user.id)
    const b = await tracked(campaign.id, user.id)

    await startValidating(a.id)
    expect(await holdSubmission(a.id, { reason: 'risk 65', riskScore: 65, riskFactors: ['single_interval_spike'] })).toBe('HELD')
    expect((await campaignBalance(db, campaign.id)).reservedOre).toBe(sek(800))

    await rejectSubmission({ submissionId: a.id, reason: 'FRAUD', strike: 'SERIOUS', suspendMembershipIfRepeat: true }, OPS)
    expect((await db.campaignMembership.findUniqueOrThrow({ where: { id: membership.id } })).state).toBe('JOINED')

    await rejectSubmission({ submissionId: b.id, reason: 'FRAUD', strike: 'SERIOUS', suspendMembershipIfRepeat: true }, OPS)
    expect((await db.campaignMembership.findUniqueOrThrow({ where: { id: membership.id } })).state).toBe('SUSPENDED')
    expect(await db.strike.count({ where: { userId: user.id, severity: 'SERIOUS' } })).toBe(2)

    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(0)
    expect(balance.availableOre).toBe(sek(1_000))
    expect(reconciles(balance)).toBe(true)
    expect(eventsOfType('membership/suspended')).toHaveLength(1)
  })
})
