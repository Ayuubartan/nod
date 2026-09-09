/**
 * S-03 tracking, S-04..S-06 validation and settlement against a real database and the
 * fake provider — docs/14 §4-6. Time is passed in explicitly so the 5-minute snapshot
 * buckets, the cadence and the validation deadline can be driven without sleeping.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, ledgerFor, makeBrand, makeCampaign, makeParticipant, resetDb } from '../helpers/db'
import { campaignBalance } from '@/lib/money/balances'
import { sek, settle } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import { eventsOfType } from '@/lib/events'
import { clearSentPushes, sentPushes } from '@/lib/notify'
import { FakeSocialProvider } from '@/lib/integrations/instagram'
import { setProviderFor } from '@/lib/integrations/social'
import { invalidateFlagCache, setFlag } from '@/lib/flags'
import { joinCampaign } from '@/lib/state/membership'
import { submitPost } from '@/lib/state/submission'
import { verifySubmission } from '@/lib/clips/verify'
import { SNAPSHOT_BUCKET_MS, TOKEN_PAUSE_MS } from '@/lib/clips/rules'
import {
  approveHeldSubmission,
  BATCH_SIZE,
  planTrackingBatches,
  runValidationsDue,
  trackBatch,
  TrackingRateLimited,
  validateSubmission,
} from '@/lib/clips/tracking'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const TOKEN = 'test-token'
const GOOD_CAPTION = 'Reklam – i samarbete med Kaffeklubben ☕ #kaffeklubben'

let fake: FakeSocialProvider
let urlCounter = 0
const nextPost = () => `72345678901234${String(urlCounter++).padStart(5, '0')}`
const ttUrl = (postId: string) => `https://www.tiktok.com/@creator/video/${postId}`

beforeEach(async () => {
  await resetDb()
  clearSentPushes()
  invalidateFlagCache()
  fake = new FakeSocialProvider('tiktok')
  setProviderFor('TIKTOK', fake)
})
afterEach(() => setProviderFor('TIKTOK', null))
afterAll(async () => {
  await db.$disconnect()
})

type CampaignArgs = Partial<Parameters<typeof makeCampaign>[0]>
type ParticipantArgs = Parameters<typeof makeParticipant>[0]

async function setup(campaignOverrides: CampaignArgs = {}, participant: ParticipantArgs = {}) {
  const brand = await makeBrand()
  const campaign = await makeCampaign({
    brandId: brand.id,
    kind: 'CLIP',
    templateKind: 'CPM',
    fixedOre: 0,
    cpmOre: sek(60),
    viewFloor: 100,
    budgetOre: sek(1_000),
    perPlacementMaxOre: sek(400),
    requiredHashtags: ['#kaffeklubben'],
    ...campaignOverrides,
  })
  const { user, account } = await makeParticipant({ platform: 'TIKTOK', followers: 5_000, avgViews30d: 4_000, ...participant })
  await joinCampaign({ campaignId: campaign.id, userId: user.id })
  return { campaign, user, account }
}

/** Submit + verify so the row is TRACKING with `initialViews` as its baseline. */
async function tracking(
  campaignId: string,
  userId: string,
  opts: { initialViews?: number; likes?: number; comments?: number; publishedAt?: Date; postId?: string } = {},
) {
  const postId = opts.postId ?? nextPost()
  const s = await submitPost({ campaignId, userId, url: ttUrl(postId) })
  fake.setPost(TOKEN, {
    postId,
    caption: GOOD_CAPTION,
    publishedAt: opts.publishedAt ?? new Date(Date.now() - HOUR),
    views: opts.initialViews ?? 1_000,
    likes: opts.likes ?? 50,
    comments: opts.comments ?? 5,
  })
  expect(await verifySubmission(s.id)).toEqual({ outcome: 'tracking' })
  return { id: s.id, postId }
}

const row = (id: string) => db.submission.findUniqueOrThrow({ where: { id } })
const later = (ms: number) => new Date(Date.now() + ms)

// ---------------------------------------------------------------------- scheduler

describe('planTrackingBatches', () => {
  it('groups due rows per (platform, account), chunks per platform and stamps queuedAt', async () => {
    const { campaign, user, account } = await setup({ perPersonCap: 50 })
    const ids: string[] = []
    for (let i = 0; i < BATCH_SIZE.TIKTOK + 3; i++) ids.push((await tracking(campaign.id, user.id)).id)
    const other = await makeParticipant({ platform: 'TIKTOK' })
    await joinCampaign({ campaignId: campaign.id, userId: other.user.id })
    const otherRow = await tracking(campaign.id, other.user.id)

    const now = later(2 * HOUR)
    const batches = await planTrackingBatches(now)

    const mine = batches.filter((b) => b.socialAccountId === account.id)
    expect(mine.map((b) => b.submissionIds.length).sort((a, b) => b - a)).toEqual([BATCH_SIZE.TIKTOK, 3])
    expect(mine.every((b) => b.platform === 'TIKTOK')).toBe(true)
    const theirs = batches.filter((b) => b.socialAccountId === other.account.id)
    expect(theirs).toEqual([{ platform: 'TIKTOK', socialAccountId: other.account.id, submissionIds: [otherRow.id] }])

    const queued = await db.submission.findMany({ where: { id: { in: [...ids, otherRow.id] } }, select: { queuedAt: true } })
    expect(queued.every((q) => q.queuedAt?.getTime() === now.getTime())).toBe(true)
  })

  it('leaves rows that are not due yet and rows queued less than 15 minutes ago', async () => {
    const { campaign, user } = await setup()
    const s = await tracking(campaign.id, user.id)

    expect(await planTrackingBatches(new Date())).toEqual([])

    const now = later(2 * HOUR)
    expect(await planTrackingBatches(now)).toHaveLength(1)
    expect(await planTrackingBatches(new Date(now.getTime() + 5 * MIN))).toEqual([])
    expect((await planTrackingBatches(new Date(now.getTime() + 16 * MIN))).flatMap((b) => b.submissionIds)).toEqual([s.id])
  })

  it('skips a platform whose circuit breaker flag is off, without touching its rows', async () => {
    const { campaign, user } = await setup()
    const s = await tracking(campaign.id, user.id)
    await setFlag('tracking.tiktok.enabled', false)
    invalidateFlagCache()

    expect(await planTrackingBatches(later(2 * HOUR))).toEqual([])
    expect((await row(s.id)).queuedAt).toBeNull()

    await setFlag('tracking.tiktok.enabled', true)
    invalidateFlagCache()
    expect(await planTrackingBatches(later(2 * HOUR))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------- worker

describe('trackBatch', () => {
  it('records a snapshot per row, updates eligible views and reschedules', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id, { initialViews: 1_000 })
    const b = await tracking(campaign.id, user.id, { initialViews: 200 })
    fake.setViews(a.postId, 1_800)
    fake.setViews(b.postId, 260)

    const now = later(2 * HOUR)
    const outcome = await trackBatch({ platform: 'TIKTOK', socialAccountId: account.id, submissionIds: [a.id, b.id] }, now)

    expect(outcome).toEqual({ observed: 2, missing: 0, rejected: 0, failed: 0, skipped: 0 })
    expect(fake.metricCalls).toEqual([[a.postId, b.postId]])
    const ra = await row(a.id)
    expect(ra.latestViews).toBe(1_800)
    expect(ra.eligibleViews).toBe(800)
    expect(ra.lastCheckedAt?.getTime()).toBe(now.getTime())
    expect(ra.nextCheckAt!.getTime()).toBeGreaterThan(now.getTime())
    expect((await row(b.id)).eligibleViews).toBe(60)
    expect(await db.submissionSnapshot.count({ where: { submissionId: a.id } })).toBe(2)
  })

  it('is idempotent inside a snapshot bucket: a replayed batch adds nothing', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    fake.setViews(a.postId, 1_500)
    const batch = { platform: 'TIKTOK' as const, socialAccountId: account.id, submissionIds: [a.id] }
    // Two calls inside the same 5-minute bucket.
    const now = new Date(Math.floor(later(2 * HOUR).getTime() / SNAPSHOT_BUCKET_MS) * SNAPSHOT_BUCKET_MS + 1_000)

    await trackBatch(batch, now)
    await trackBatch(batch, new Date(now.getTime() + 30 * 1000))

    expect(await db.submissionSnapshot.count({ where: { submissionId: a.id } })).toBe(2)
    expect((await row(a.id)).eligibleViews).toBe(500)
  })

  it('skips rows that moved on since the scheduler ran', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    await db.submission.update({ where: { id: a.id }, data: { state: 'QUALIFIED' } })

    const outcome = await trackBatch({ platform: 'TIKTOK', socialAccountId: account.id, submissionIds: [a.id] }, later(2 * HOUR))

    expect(outcome).toEqual({ observed: 0, missing: 0, rejected: 0, failed: 0, skipped: 1 })
    expect(fake.metricCalls).toEqual([])
  })

  it('counts a missing post once, then rejects DELETED_EARLY on the second miss and releases the reservation', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    fake.removePost(TOKEN, a.postId)
    const batch = { platform: 'TIKTOK' as const, socialAccountId: account.id, submissionIds: [a.id] }

    expect(await trackBatch(batch, later(2 * HOUR))).toMatchObject({ missing: 1, rejected: 0 })
    let r = await row(a.id)
    expect(r.state).toBe('TRACKING')
    expect(r.consecutiveMissing).toBe(1)

    expect(await trackBatch(batch, later(4 * HOUR))).toMatchObject({ missing: 1, rejected: 1 })
    r = await row(a.id)
    expect(r.state).toBe('REJECTED')
    expect(r.rejectReason).toBe('DELETED_EARLY')
    expect(r.reservationOre).toBe(0)
    expect((await ledgerFor(campaign.id)).map((e) => e.type)).toEqual(['DEPOSIT', 'RESERVE', 'RELEASE_RESERVATION'])
    expect(await campaignBalance(db, campaign.id)).toMatchObject({ reservedOre: 0 })
    expect(await db.strike.count({ where: { userId: user.id, severity: 'SERIOUS' } })).toBe(1)
    expect(sentPushes.filter((p) => p.userId === user.id)).toHaveLength(1)
    expect(eventsOfType('submission/rejected')).toHaveLength(1)
  })

  it('a reappearing post resets the missing counter', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    const batch = { platform: 'TIKTOK' as const, socialAccountId: account.id, submissionIds: [a.id] }

    fake.removePost(TOKEN, a.postId)
    await trackBatch(batch, later(2 * HOUR))
    fake.setPost(TOKEN, { postId: a.postId, caption: GOOD_CAPTION, views: 1_100 })
    await trackBatch(batch, later(4 * HOUR))
    fake.removePost(TOKEN, a.postId)
    await trackBatch(batch, later(6 * HOUR))

    const r = await row(a.id)
    expect(r.state).toBe('TRACKING')
    expect(r.consecutiveMissing).toBe(1)
  })

  it('throws TrackingRateLimited with the provider retry-after so the worker backs off', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    fake.failNext('rate_limited', 45_000)

    const error = await trackBatch({ platform: 'TIKTOK', socialAccountId: account.id, submissionIds: [a.id] }, later(2 * HOUR)).catch(
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(TrackingRateLimited)
    expect((error as TrackingRateLimited).retryAfterMs).toBe(45_000)
    expect((error as TrackingRateLimited).platform).toBe('TIKTOK')
    // Nothing was recorded against the rows.
    expect((await row(a.id)).consecutiveFailures).toBe(0)
  })

  it('pauses every TRACKING row of the account for 6 h and pushes the creator on an invalid token', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    const b = await tracking(campaign.id, user.id)
    fake.failNext('unauthorized')
    const now = later(2 * HOUR)

    const outcome = await trackBatch({ platform: 'TIKTOK', socialAccountId: account.id, submissionIds: [a.id] }, now)

    expect(outcome).toMatchObject({ paused: 'unauthorized' })
    for (const id of [a.id, b.id]) {
      const r = await row(id)
      expect(r.trackingPausedAt?.getTime()).toBe(now.getTime())
      expect(r.nextCheckAt?.getTime()).toBe(now.getTime() + TOKEN_PAUSE_MS)
      expect(r.queuedAt).toBeNull()
    }
    const pushes = sentPushes.filter((p) => p.userId === user.id)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.body).toContain('TikTok')
  })

  it('pauses the account when no usable token exists', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    await db.socialAccount.update({ where: { id: account.id }, data: { accessToken: null } })

    const outcome = await trackBatch({ platform: 'TIKTOK', socialAccountId: account.id, submissionIds: [a.id] }, later(2 * HOUR))

    expect(outcome).toMatchObject({ paused: 'no_token' })
    expect((await row(a.id)).trackingPausedAt).not.toBeNull()
  })

  it('records a check failure per row on a transient provider error and backs off after three', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    const batch = { platform: 'TIKTOK' as const, socialAccountId: account.id, submissionIds: [a.id] }

    let delays: number[] = []
    for (let i = 0; i < 4; i++) {
      fake.failNext('transient')
      const now = later((2 + i) * HOUR)
      expect(await trackBatch(batch, now)).toMatchObject({ failed: 1 })
      const r = await row(a.id)
      expect(r.consecutiveFailures).toBe(i + 1)
      delays = [...delays, r.nextCheckAt!.getTime() - now.getTime()]
    }
    // Same cadence for the first failures, exponential once the third one hits.
    expect(delays[0]).toBe(delays[1])
    expect(delays[3]!).toBeGreaterThan(delays[2]!)
    expect(delays[2]!).toBeGreaterThan(delays[1]!)
    expect((await row(a.id)).state).toBe('TRACKING')
  })
})

// ---------------------------------------------------------------------- validation

describe('validateSubmission', () => {
  it('after the window: final pull, fraud call, settlement into the ledger, push to the creator', async () => {
    const { campaign, user } = await setup()
    const a = await tracking(campaign.id, user.id, { initialViews: 1_000, likes: 60, comments: 10 })
    fake.setViews(a.postId, 3_000)
    const now = later(8 * DAY)

    const outcome = await validateSubmission(a.id, now)

    const expected = settle(
      { fixedOre: 0, cpmOre: sek(60), viewFloor: 100, bonusAtViews: null, bonusOre: null, takeRateBps: DEFAULTS.takeRateBps },
      2_000,
      sek(400),
    )
    expect(outcome).toEqual({ outcome: 'qualified', qualifiedViews: 2_000, toUserOre: expected.toUserOre, riskScore: expect.any(Number) })
    expect(expected.toUserOre).toBeGreaterThan(0)

    const r = await row(a.id)
    expect(r.state).toBe('QUALIFIED')
    expect(r.eligibleViews).toBe(2_000)
    expect(r.settledAt).not.toBeNull()
    expect(r.riskScore).toBeLessThan(60)

    const types = (await ledgerFor(campaign.id)).map((e) => e.type)
    expect(types.slice(0, 2)).toEqual(['DEPOSIT', 'RESERVE'])
    expect(types).toContain('SETTLE')
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(0)
    expect(balance.spentOre).toBe(expected.allInOre)

    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } })
    const accrued = await db.ledgerEntry.aggregate({ where: { walletId: wallet.id }, _sum: { amountOre: true } })
    expect(accrued._sum.amountOre).toBe(expected.toUserOre)

    const pushes = sentPushes.filter((p) => p.userId === user.id)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.body).toMatch(/2[\s\u00a0]000/)
    expect(eventsOfType('submission/qualified')).toHaveLength(1)
    expect(eventsOfType('money/payout.accrued')).toHaveLength(1)
  })

  it('pays 0 kr and says so when the post never cleared the view floor', async () => {
    const { campaign, user } = await setup()
    const a = await tracking(campaign.id, user.id, { initialViews: 1_000 })
    fake.setViews(a.postId, 1_050)

    const outcome = await validateSubmission(a.id, later(8 * DAY))

    expect(outcome).toMatchObject({ outcome: 'qualified', qualifiedViews: 50, toUserOre: 0 })
    expect((await row(a.id)).state).toBe('QUALIFIED')
    expect(await campaignBalance(db, campaign.id)).toMatchObject({ reservedOre: 0, spentOre: 0 })
    const pushes = sentPushes.filter((p) => p.userId === user.id)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.body).not.toMatch(/\d+ kr/)
    expect(pushes[0]!.body).toContain('under gränsen')
  })

  it('holds for ops when the risk band lands at 60-79 and keeps the reservation', async () => {
    // Brand-new account (fixtures are created now), 25x its baseline and 12 views per follower.
    const { campaign, user } = await setup({}, { followers: 820, avgViews30d: 400 })
    const a = await tracking(campaign.id, user.id, { initialViews: 0, likes: 300, comments: 20 })
    fake.setViews(a.postId, 10_000)

    const outcome = await validateSubmission(a.id, later(8 * DAY))

    expect(outcome).toMatchObject({ outcome: 'held' })
    expect((outcome as { riskScore: number }).riskScore).toBeGreaterThanOrEqual(60)
    expect((outcome as { riskFactors: string[] }).riskFactors).toEqual(expect.arrayContaining(['velocity', 'account_age']))
    const r = await row(a.id)
    expect(r.state).toBe('HELD')
    expect(r.reservationOre).toBe(sek(400))
    expect(await campaignBalance(db, campaign.id)).toMatchObject({ reservedOre: sek(400), spentOre: 0 })
    expect(sentPushes.filter((p) => p.userId === user.id)).toHaveLength(0)
    expect(eventsOfType('submission/held')).toHaveLength(1)
  })

  it('rejects FRAUD at 80+, with a strike, and releases the reservation', async () => {
    const { campaign, user } = await setup({}, { followers: 820, avgViews30d: 400 })
    // A prior confirmed fraud rejection on another campaign pushes history to its maximum.
    const other = await makeCampaign({ brandId: (await makeBrand('Other')).id, kind: 'CLIP', templateKind: 'CPM', cpmOre: sek(60) })
    await joinCampaign({ campaignId: other.id, userId: user.id })
    const prior = await submitPost({ campaignId: other.id, userId: user.id, url: ttUrl(nextPost()) })
    await db.submission.update({ where: { id: prior.id }, data: { state: 'REJECTED', rejectReason: 'FRAUD' } })

    const a = await tracking(campaign.id, user.id, { initialViews: 0, likes: 0, comments: 0 })
    fake.setViews(a.postId, 10_000)

    const outcome = await validateSubmission(a.id, later(8 * DAY))

    expect(outcome).toMatchObject({ outcome: 'rejected', reason: 'FRAUD' })
    const r = await row(a.id)
    expect(r.state).toBe('REJECTED')
    expect(r.rejectReason).toBe('FRAUD')
    expect(r.reservationOre).toBe(0)
    expect(await campaignBalance(db, campaign.id)).toMatchObject({ reservedOre: 0, spentOre: 0 })
    expect(await db.strike.count({ where: { userId: user.id } })).toBe(1)
    expect(sentPushes.filter((p) => p.userId === user.id)).toHaveLength(1)
  })

  it('a single miss at the deadline retries instead of settling on stale numbers', async () => {
    const { campaign, user } = await setup()
    const a = await tracking(campaign.id, user.id)
    fake.removePost(TOKEN, a.postId)

    const outcome = await validateSubmission(a.id, later(8 * DAY))

    expect(outcome).toMatchObject({ outcome: 'retry', why: 'transient' })
    const r = await row(a.id)
    expect(r.state).toBe('VALIDATING')
    expect(r.consecutiveMissing).toBe(1)
    expect(r.reservationOre).toBe(sek(400))

    // Second miss: the post is gone.
    expect(await validateSubmission(a.id, later(8 * DAY + HOUR))).toEqual({ outcome: 'rejected', reason: 'DELETED_EARLY' })
    expect((await row(a.id)).rejectReason).toBe('DELETED_EARLY')
  })

  it('provider trouble on the final pull returns retry and leaves the row VALIDATING', async () => {
    const { campaign, user, account } = await setup()
    const a = await tracking(campaign.id, user.id)
    fake.failNext('rate_limited', 20_000)

    expect(await validateSubmission(a.id, later(8 * DAY))).toEqual({ outcome: 'retry', why: 'rate_limited', retryAfterMs: 20_000 })
    expect((await row(a.id)).state).toBe('VALIDATING')

    fake.failNext('unauthorized')
    const now = later(8 * DAY + HOUR)
    expect(await validateSubmission(a.id, now)).toMatchObject({ outcome: 'retry', why: 'unauthorized' })
    // A VALIDATING row is not paused (only TRACKING rows carry nextCheckAt), but the
    // account's other tracking rows are.
    const b = await tracking(campaign.id, user.id)
    fake.failNext('unauthorized')
    await validateSubmission(a.id, later(8 * DAY + 2 * HOUR))
    expect((await row(b.id)).trackingPausedAt).not.toBeNull()
    expect(account.id).toBeTruthy()

    // Then it recovers and settles.
    fake.setViews(a.postId, 2_000)
    expect(await validateSubmission(a.id, later(8 * DAY + 3 * HOUR))).toMatchObject({ outcome: 'qualified', qualifiedViews: 1_000 })
  })

  it('is idempotent: a replay after settlement is skipped and posts nothing twice', async () => {
    const { campaign, user } = await setup()
    const a = await tracking(campaign.id, user.id)
    fake.setViews(a.postId, 2_000)

    await validateSubmission(a.id, later(8 * DAY))
    const before = (await ledgerFor(campaign.id)).length
    expect(await validateSubmission(a.id, later(8 * DAY + MIN))).toEqual({ outcome: 'skipped', state: 'QUALIFIED' })
    expect((await ledgerFor(campaign.id)).length).toBe(before)
    expect(sentPushes.filter((p) => p.userId === user.id)).toHaveLength(1)
  })

  it('budget-exhausted submissions settle at 0 kr and the creator is told', async () => {
    const { campaign, user } = await setup({ budgetOre: sek(400), perPlacementMaxOre: sek(400) })
    const funded = await tracking(campaign.id, user.id)
    const unpaid = await tracking(campaign.id, user.id)
    expect((await row(unpaid.id)).reservationOre).toBe(0)
    fake.setViews(unpaid.postId, 5_000)

    const outcome = await validateSubmission(unpaid.id, later(8 * DAY))

    expect(outcome).toMatchObject({ outcome: 'qualified', qualifiedViews: 4_000, toUserOre: 0 })
    expect((await row(unpaid.id)).state).toBe('QUALIFIED')
    expect(await campaignBalance(db, campaign.id)).toMatchObject({ reservedOre: sek(400), spentOre: 0 })
    expect(funded.id).toBeTruthy()
    const pushes = sentPushes.filter((p) => p.userId === user.id)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.body).not.toMatch(/\d+ kr/)
    expect(pushes[0]!.body).toContain('Budgeten')
  })
})

describe('runValidationsDue', () => {
  it('validates every TRACKING row past its window and nothing else', async () => {
    const { campaign, user } = await setup()
    const due = await tracking(campaign.id, user.id)
    const notDue = await tracking(campaign.id, user.id)
    await db.submission.update({ where: { id: notDue.id }, data: { validationEndsAt: later(30 * DAY) } })
    fake.setViews(due.postId, 2_000)

    const outcomes = await runValidationsDue(later(8 * DAY))

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ outcome: 'qualified' })
    expect((await row(notDue.id)).state).toBe('TRACKING')
  })
})

describe('approveHeldSubmission', () => {
  it('settles a HELD row on the recorded numbers with the ops actor on the audit trail', async () => {
    const { campaign, user } = await setup({}, { followers: 820, avgViews30d: 400 })
    const a = await tracking(campaign.id, user.id, { initialViews: 0, likes: 300, comments: 20 })
    fake.setViews(a.postId, 10_000)
    expect(await validateSubmission(a.id, later(8 * DAY))).toMatchObject({ outcome: 'held' })

    const outcome = await approveHeldSubmission(a.id, { kind: 'OPS', id: 'ops-1' })

    expect(outcome).toMatchObject({ outcome: 'qualified', qualifiedViews: 10_000 })
    // 10 000 views × 60 kr CPM = 600 kr, capped by the 400 kr reservation.
    const expected = settle(
      { fixedOre: 0, cpmOre: sek(60), viewFloor: 100, bonusAtViews: null, bonusOre: null, takeRateBps: DEFAULTS.takeRateBps },
      10_000,
      sek(400),
    )
    expect(expected.allInOre).toBe(sek(400))
    expect((outcome as { toUserOre: number }).toUserOre).toBe(expected.toUserOre)
    expect((await row(a.id)).state).toBe('QUALIFIED')
    expect(await campaignBalance(db, campaign.id)).toMatchObject({ reservedOre: 0, spentOre: sek(400) })
    const audit = await db.auditLog.findMany({ where: { entity: 'Submission', entityId: a.id, toState: 'QUALIFIED' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor).toContain('ops-1')
    expect(sentPushes.filter((p) => p.userId === user.id)).toHaveLength(1)
  })

  it('does nothing for a row that is not HELD', async () => {
    const { campaign, user } = await setup()
    const a = await tracking(campaign.id, user.id)
    expect(await approveHeldSubmission(a.id, { kind: 'OPS', id: 'ops-1' })).toEqual({ outcome: 'skipped', state: 'TRACKING' })
  })
})
