/**
 * S-02 ownership + caption verification against a real database and the fake provider —
 * docs/14 §3. The fake stands in for TikTok; the Instagram and TikTok wire shapes are
 * covered by the scripted-fetch tests.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, ledgerFor, makeBrand, makeCampaign, makeParticipant, resetDb } from '../helpers/db'
import { campaignBalance } from '@/lib/money/balances'
import { sek } from '@/lib/money/calc'
import { eventsOfType } from '@/lib/events'
import { FakeSocialProvider } from '@/lib/integrations/instagram'
import { setProviderFor } from '@/lib/integrations/social'
import { joinCampaign } from '@/lib/state/membership'
import { submitPost } from '@/lib/state/submission'
import { verifySubmission } from '@/lib/clips/verify'
import { TOKEN_PAUSE_MS } from '@/lib/clips/rules'

const HOUR = 60 * 60 * 1000
const TOKEN = 'test-token' // what tests/helpers/db.ts encrypts into every fixture account
const GOOD_CAPTION = 'Reklam – i samarbete med Kaffeklubben ☕ #kaffeklubben'

let fake: FakeSocialProvider
let urlCounter = 0
const nextPost = () => `72345678901234${String(urlCounter++).padStart(5, '0')}`
const ttUrl = (postId: string) => `https://www.tiktok.com/@creator/video/${postId}`

beforeEach(async () => {
  await resetDb()
  fake = new FakeSocialProvider('tiktok')
  setProviderFor('TIKTOK', fake)
})
afterEach(() => setProviderFor('TIKTOK', null))
afterAll(async () => {
  await db.$disconnect()
})

async function setup(campaignOverrides: Partial<Parameters<typeof makeCampaign>[0]> = {}) {
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
  const { user, account } = await makeParticipant({ platform: 'TIKTOK' })
  await joinCampaign({ campaignId: campaign.id, userId: user.id })
  return { campaign, user, account }
}

async function submitted(campaignId: string, userId: string, postId = nextPost()) {
  const s = await submitPost({ campaignId, userId, url: ttUrl(postId) })
  return { ...s, postId }
}

describe('verifySubmission — happy path', () => {
  it('finds the post under the creator token, stores the baseline and starts tracking', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    const publishedAt = new Date(Date.now() - 2 * HOUR)
    fake.setPost(TOKEN, { postId: s.postId, caption: GOOD_CAPTION, publishedAt, views: 1_234, likes: 40, comments: 3, shares: 7 })

    expect(await verifySubmission(s.id)).toEqual({ outcome: 'tracking' })

    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.state).toBe('TRACKING')
    expect(row.providerMediaId).toBe(s.postId)
    expect(row.caption).toBe(GOOD_CAPTION)
    expect(row.publishedAt).toEqual(publishedAt)
    expect(row.initialViews).toBe(1_234)
    expect(row.latestLikes).toBe(40)
    expect(row.latestShares).toBe(7)
    expect(row.eligibleViews).toBe(0)
    expect(row.nextCheckAt).not.toBeNull()
    expect(await db.submissionSnapshot.count({ where: { submissionId: s.id } })).toBe(1)
    expect(eventsOfType('submission/tracking')).toHaveLength(1)
    // The reservation from S-01 is untouched by verification.
    expect(row.reservationOre).toBe(sek(400))
  })

  it('accepts the paid-partnership label in place of the caption phrase', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s.postId, caption: 'morgonkaffe #kaffeklubben', publishedAt: new Date(), isPaidPartnership: true })
    expect(await verifySubmission(s.id)).toEqual({ outcome: 'tracking' })
  })

  it('is a no-op on anything past RECEIVED / FIX_DISCLOSURE', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s.postId, caption: GOOD_CAPTION, publishedAt: new Date() })
    await verifySubmission(s.id)
    expect(await verifySubmission(s.id)).toEqual({ outcome: 'skipped', state: 'TRACKING' })
    expect(await verifySubmission('nope')).toEqual({ outcome: 'skipped', state: 'MISSING' })
  })
})

describe('verifySubmission — rejections', () => {
  it("rejects NOT_OWNER when the post is not in the creator's own media, releasing the reservation", async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    // The post exists — but under someone else's token.
    fake.setPost('someone-else', { postId: s.postId, caption: GOOD_CAPTION, publishedAt: new Date() })

    expect(await verifySubmission(s.id)).toEqual({ outcome: 'rejected', reason: 'NOT_OWNER' })

    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.state).toBe('REJECTED')
    expect(row.rejectReason).toBe('NOT_OWNER')
    expect(row.reservationOre).toBe(0)
    const balance = await campaignBalance(db, campaign.id)
    expect(balance.reservedOre).toBe(0)
    expect(balance.availableOre).toBe(sek(1_000))
    expect((await ledgerFor(campaign.id)).map((e) => e.type)).toEqual(['DEPOSIT', 'RESERVE', 'RELEASE_RESERVATION'])
    expect(eventsOfType('submission/rejected')).toHaveLength(1)
  })

  it('rejects OUTSIDE_WINDOW for a post older than 24 h before go-live', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s.postId, caption: GOOD_CAPTION, publishedAt: new Date(Date.now() - 3 * 24 * HOUR) })

    expect(await verifySubmission(s.id)).toEqual({ outcome: 'rejected', reason: 'OUTSIDE_WINDOW' })
    expect((await db.submission.findUniqueOrThrow({ where: { id: s.id } })).rejectReason).toBe('OUTSIDE_WINDOW')
  })

  it('checks ownership before the window, and the window before the caption', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    // Old AND undisclosed AND not owned → NOT_OWNER wins.
    fake.setPost('someone-else', { postId: s.postId, caption: 'no tags', publishedAt: new Date(Date.now() - 3 * 24 * HOUR) })
    expect(await verifySubmission(s.id)).toEqual({ outcome: 'rejected', reason: 'NOT_OWNER' })

    const s2 = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s2.postId, caption: 'no tags', publishedAt: new Date(Date.now() - 3 * 24 * HOUR) })
    expect(await verifySubmission(s2.id)).toEqual({ outcome: 'rejected', reason: 'OUTSIDE_WINDOW' })
  })
})

describe('verifySubmission — disclosure fix window (rule 5)', () => {
  it('opens a 12 h window when the disclosure or a required tag is missing, keeping the reservation', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s.postId, caption: 'bästa kaffet #morgon', publishedAt: new Date() })
    const now = new Date()

    expect(await verifySubmission(s.id, now)).toEqual({
      outcome: 'fix_disclosure',
      disclosureOk: false,
      missingHashtags: ['kaffeklubben'],
      missingMentions: [],
    })

    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.state).toBe('FIX_DISCLOSURE')
    expect(row.fixWindowEndsAt?.getTime()).toBe(now.getTime() + 12 * HOUR)
    expect(row.reservationOre).toBe(sek(400))
    expect(eventsOfType('submission/disclosure.fix.window')).toHaveLength(1)
  })

  it('passes once the caption is fixed inside the window', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s.postId, caption: 'bästa kaffet', publishedAt: new Date() })
    await verifySubmission(s.id)

    // Still missing an hour later: the window keeps running, nothing changes.
    const later = new Date(Date.now() + HOUR)
    expect((await verifySubmission(s.id, later)).outcome).toBe('fix_disclosure')
    expect((await db.submission.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('FIX_DISCLOSURE')

    fake.setPost(TOKEN, { postId: s.postId, caption: GOOD_CAPTION, publishedAt: new Date() })
    expect(await verifySubmission(s.id, later)).toEqual({ outcome: 'tracking' })
    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.state).toBe('TRACKING')
    expect(row.fixWindowEndsAt).toBeNull()
  })

  it('rejects NO_DISCLOSURE once the window has closed and the caption is still bare', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s.postId, caption: 'bästa kaffet', publishedAt: new Date() })
    await verifySubmission(s.id)

    const afterWindow = new Date(Date.now() + 12 * HOUR + 1)
    expect(await verifySubmission(s.id, afterWindow)).toEqual({ outcome: 'rejected', reason: 'NO_DISCLOSURE' })
    const row = await db.submission.findUniqueOrThrow({ where: { id: s.id } })
    expect(row.rejectReason).toBe('NO_DISCLOSURE')
    expect(row.rejectNote).toContain('disclosure')
    expect(row.rejectNote).toContain('kaffeklubben')
    expect(row.reservationOre).toBe(0)
    expect((await campaignBalance(db, campaign.id)).reservedOre).toBe(0)
  })

  it('resolves the disclosure phrase with the brand name', async () => {
    const { campaign, user } = await setup({ requiredHashtags: [] })
    const s = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s.postId, caption: 'Reklam – i samarbete med Kaffeklubben', publishedAt: new Date() })
    expect(await verifySubmission(s.id)).toEqual({ outcome: 'tracking' })
  })
})

describe('verifySubmission — provider trouble never rejects', () => {
  it("returns retry with the provider's retry-after on a rate limit and leaves the row as is", async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: s.postId, caption: GOOD_CAPTION, publishedAt: new Date() })
    fake.failNext('rate_limited', 90_000)

    expect(await verifySubmission(s.id)).toEqual({ outcome: 'retry', why: 'rate_limited', retryAfterMs: 90_000 })
    expect((await db.submission.findUniqueOrThrow({ where: { id: s.id } })).state).toBe('RECEIVED')
    // The fake recovers, and so does the submission.
    expect(await verifySubmission(s.id)).toEqual({ outcome: 'tracking' })
  })

  it('returns retry on a transient error with the default wait', async () => {
    const { campaign, user } = await setup()
    const s = await submitted(campaign.id, user.id)
    fake.failNext('transient')
    const r = await verifySubmission(s.id)
    expect(r.outcome).toBe('retry')
    if (r.outcome === 'retry') expect(r.retryAfterMs).toBe(5 * 60_000)
  })

  it('pauses tracking for the whole account when the token is dead', async () => {
    const { campaign, user, account } = await setup()
    // Another submission on the same account already tracking.
    const other = await submitted(campaign.id, user.id)
    fake.setPost(TOKEN, { postId: other.postId, caption: GOOD_CAPTION, publishedAt: new Date() })
    await verifySubmission(other.id)

    const s = await submitted(campaign.id, user.id)
    fake.failNext('unauthorized')
    const now = new Date()
    expect(await verifySubmission(s.id, now)).toEqual({ outcome: 'retry', why: 'unauthorized', retryAfterMs: TOKEN_PAUSE_MS })

    const paused = await db.submission.findUniqueOrThrow({ where: { id: other.id } })
    expect(paused.trackingPausedAt).toEqual(now)
    expect(paused.nextCheckAt?.getTime()).toBe(now.getTime() + TOKEN_PAUSE_MS)
    expect(paused.socialAccountId).toBe(account.id)
  })

  it('returns retry when the account has no usable token', async () => {
    const { campaign, user, account } = await setup()
    const s = await submitted(campaign.id, user.id)
    await db.socialAccount.update({ where: { id: account.id }, data: { accessToken: null } })
    expect((await verifySubmission(s.id)).outcome).toBe('retry')
  })
})
