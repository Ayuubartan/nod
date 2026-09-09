import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, makeParticipant, resetDb } from './helpers/db'
import { encrypt, tryDecrypt } from '@/lib/crypto'
import { eventsOfType } from '@/lib/events'
import { FakeSocialProvider } from '@/lib/integrations/instagram'
import { setProviderFor } from '@/lib/integrations/social'
import type { SocialToken } from '@/lib/integrations/types'
import { accountAnalytics, freshToken, recordSnapshot, syncAccount } from '@/lib/social-sync'

/**
 * Analytics sync and token freshness against the test database (docs/06 sections 1-2).
 * The provider is a fake per platform; what is under test is what NOD stores and when
 * it refreshes.
 */

class CountingFake extends FakeSocialProvider {
  refreshes = 0
  failRefresh = false
  constructor(platform: 'instagram' | 'tiktok') {
    super(platform)
  }
  override async refresh(token: string, refreshToken?: string | null): Promise<SocialToken> {
    this.refreshes += 1
    if (this.failRefresh) throw new Error('nope')
    return { token: `${token}-r`, refreshToken: refreshToken ? `${refreshToken}-r` : undefined, expiresAt: new Date(Date.now() + 86_400_000) }
  }
}

let tiktok: CountingFake

beforeEach(async () => {
  await resetDb()
  tiktok = new CountingFake('tiktok')
  setProviderFor('TIKTOK', tiktok)
})

afterEach(() => {
  setProviderFor('TIKTOK', null)
  setProviderFor('INSTAGRAM', null)
})

afterAll(async () => {
  await db.$disconnect()
})

async function makeTikTok(overrides: Partial<{ expiresInMs: number; token: string | null }> = {}) {
  const { user } = await makeParticipant()
  return db.socialAccount.create({
    data: {
      userId: user.id,
      platform: 'TIKTOK',
      handle: 'lisa',
      platformUserId: `tt_${user.id}`,
      tier: 'CONNECTED_API',
      accountType: 'creator',
      followers: 1000,
      avgViews30d: 400,
      accessToken: overrides.token === null ? null : encrypt(overrides.token ?? 'fake-token-7'),
      refreshToken: encrypt('fake-refresh-7'),
      tokenExpiresAt: new Date(Date.now() + (overrides.expiresInMs ?? 86_400_000)),
    },
  })
}

describe('freshToken', () => {
  it('returns the stored token when it is not about to expire', async () => {
    const account = await makeTikTok()
    await expect(freshToken(account)).resolves.toBe('fake-token-7')
    expect(tiktok.refreshes).toBe(0)
  })

  it('refreshes and persists both tokens when expiry is within the hour', async () => {
    const account = await makeTikTok({ expiresInMs: 10 * 60 * 1000 })
    await expect(freshToken(account)).resolves.toBe('fake-token-7-r')
    expect(tiktok.refreshes).toBe(1)

    const stored = await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(tryDecrypt(stored.accessToken)).toBe('fake-token-7-r')
    expect(tryDecrypt(stored.refreshToken)).toBe('fake-refresh-7-r')
    expect(stored.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 80_000_000)
  })

  it('returns null and emits when the refresh fails, without touching the row', async () => {
    tiktok.failRefresh = true
    const account = await makeTikTok({ expiresInMs: 1000 })
    await expect(freshToken(account)).resolves.toBeNull()
    expect(eventsOfType('account/token.refresh.failed')).toHaveLength(1)
    const stored = await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(tryDecrypt(stored.accessToken)).toBe('fake-token-7')
  })

  it('returns null when there is no token', async () => {
    const account = await makeTikTok({ token: null })
    await expect(freshToken(account)).resolves.toBeNull()
  })
})

describe('syncAccount', () => {
  it('updates the numbers and appends a snapshot', async () => {
    const account = await makeTikTok()
    const result = await syncAccount(account.id)
    expect(result.ok).toBe(true)

    const stored = await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } })
    // FakeSocialProvider derives followers from the token seed: 300 + (7 % 40) * 120.
    expect(stored.followers).toBe(1140)
    expect(stored.avgViews30d).toBe(627)
    expect(stored.lastSyncedAt).not.toBeNull()

    const snapshots = await db.socialAccountSnapshot.findMany({ where: { accountId: account.id } })
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ followers: 1140, avgViews30d: 627, posts30d: 0 })
  })

  it('skips disconnected accounts and keeps the last good numbers on API failure', async () => {
    const account = await makeTikTok()
    await db.socialAccount.update({ where: { id: account.id }, data: { tier: 'DISCONNECTED' } })
    await expect(syncAccount(account.id)).resolves.toEqual({ ok: false, reason: 'no-token' })

    await db.socialAccount.update({ where: { id: account.id }, data: { tier: 'CONNECTED_API' } })
    tiktok.profile = async () => {
      throw new Error('rate limited')
    }
    await expect(syncAccount(account.id)).resolves.toEqual({ ok: false, reason: 'api-error' })
    const stored = await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(stored.followers).toBe(1000)
    expect(await db.socialAccountSnapshot.count()).toBe(0)
  })
})

describe('accountAnalytics', () => {
  it('reports deltas and history over the window, null with fewer than two points', async () => {
    const account = await makeTikTok()
    // makeParticipant also creates an Instagram account; pick the TikTok one.
    const before = (await accountAnalytics(account.userId)).find((a) => a.platform === 'TIKTOK')
    expect(before).toMatchObject({ platform: 'TIKTOK', followersDelta30d: null, avgViewsDelta30d: null, history: [] })

    await db.socialAccountSnapshot.create({
      data: { accountId: account.id, followers: 900, avgViews30d: 300, capturedAt: new Date(Date.now() - 20 * 86_400_000) },
    })
    // Outside the 30-day window: ignored.
    await db.socialAccountSnapshot.create({
      data: { accountId: account.id, followers: 1, avgViews30d: 1, capturedAt: new Date(Date.now() - 60 * 86_400_000) },
    })
    await recordSnapshot(account.id, { followers: 1100, avgViews30d: 450 }, 6)

    const a = (await accountAnalytics(account.userId)).find((x) => x.platform === 'TIKTOK')
    expect(a).toMatchObject({ followers: 1100, avgViews30d: 450, posts30d: 6, followersDelta30d: 200, avgViewsDelta30d: 150 })
    expect(a!.history.map((h) => h.followers)).toEqual([900, 1100])
  })
})
