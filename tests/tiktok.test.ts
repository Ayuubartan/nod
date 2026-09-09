import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertNoWriteScopes, TIKTOK_SCOPES, TikTokProvider } from '@/lib/integrations/tiktok'
import { assertNoWriteScopes as igAssert } from '@/lib/integrations/instagram'
import { FakeSocialProvider } from '@/lib/integrations/instagram'
import { platformFromSlug, platformSlug, providerFor, setProviderFor } from '@/lib/integrations/social'

/**
 * TikTok provider against a scripted fetch. Verifies the OAuth shapes (Login Kit v2),
 * the read-only scope list (CLAUDE.md rule 6) and the 30-day average derivation.
 */

type Call = { url: string; init?: RequestInit }

function scriptFetch(handlers: Array<(call: Call) => unknown>) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const call = { url, init }
    calls.push(call)
    const handler = handlers.shift()
    if (!handler) throw new Error(`unexpected fetch ${url}`)
    return new Response(JSON.stringify(handler(call)), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const DAY = 24 * 60 * 60
const nowS = () => Math.floor(Date.now() / 1000)

const ok = <T,>(data: T) => ({ data, error: { code: 'ok', message: '', log_id: 'x' } })

describe('TikTok provider', () => {
  const provider = new TikTokProvider('key', 'secret', 'https://joinbooga.se/api/auth/tiktok/callback')

  beforeEach(() => vi.useRealTimers())
  afterEach(() => vi.unstubAllGlobals())

  it('requests read-only scopes only', () => {
    expect(TIKTOK_SCOPES).toEqual(['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'])
    expect(() => assertNoWriteScopes(['video.publish'])).toThrow(/rule 6/)
    expect(() => assertNoWriteScopes(['video.upload'])).toThrow(/rule 6/)
    expect(() => igAssert(['instagram_business_content_publish'])).toThrow(/rule 6/)
  })

  it('builds the Login Kit authorize URL with state', () => {
    const url = new URL(provider.authUrl('abc123'))
    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/')
    expect(url.searchParams.get('client_key')).toBe('key')
    expect(url.searchParams.get('scope')).toBe('user.info.basic,user.info.profile,user.info.stats,video.list')
    expect(url.searchParams.get('state')).toBe('abc123')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).not.toMatch(/publish|upload/)
  })

  it('exchanges the code, reads the profile and keeps the refresh token', async () => {
    const calls = scriptFetch([
      () => ({ access_token: 'acc', expires_in: 86400, refresh_token: 'ref', refresh_expires_in: 31536000, open_id: 'o1', scope: '', token_type: 'Bearer' }),
      () => ok({ user: { open_id: 'o1', username: 'lisa', display_name: 'Lisa', follower_count: 1200, video_count: 12 } }),
      () => ok({ videos: [{ id: 'v1', create_time: nowS() - DAY, view_count: 500 }] }),
    ])

    const connected = await provider.exchangeCode('the-code')

    expect(calls[0]?.url).toBe('https://open.tiktokapis.com/v2/oauth/token/')
    const body = calls[0]?.init?.body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('client_secret')).toBe('secret')
    expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer acc')

    expect(connected).toMatchObject({
      platformUserId: 'o1',
      handle: 'lisa',
      accountType: 'creator',
      isPrivate: false,
      token: 'acc',
      refreshToken: 'ref',
    })
    expect(connected.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 80_000_000)
  })

  it('flags an account whose videos cannot be listed as private', async () => {
    scriptFetch([
      () => ({ access_token: 'acc', expires_in: 86400, refresh_token: 'ref', refresh_expires_in: 1, open_id: 'o2', scope: '', token_type: 'Bearer' }),
      () => ok({ user: { open_id: 'o2', username: 'priv', follower_count: 50, video_count: 9 } }),
      () => ok({ videos: [] }),
    ])
    const connected = await provider.exchangeCode('c')
    expect(connected.isPrivate).toBe(true)
  })

  it('derives the 30-day average from public view counts inside the window', async () => {
    scriptFetch([
      () => ok({ user: { open_id: 'o1', follower_count: 1200 } }),
      () =>
        ok({
          videos: [
            { id: 'a', create_time: nowS() - 2 * DAY, view_count: 1000 },
            { id: 'b', create_time: nowS() - 10 * DAY, view_count: 500 },
            { id: 'old', create_time: nowS() - 45 * DAY, view_count: 99999 },
          ],
        }),
    ])
    const profile = await provider.profile('acc')
    expect(profile).toEqual({ followers: 1200, avgViews30d: 750 })
  })

  it('reads a single video count through video.query and fails loudly when it is gone', async () => {
    scriptFetch([
      () => ok({ videos: [{ id: 'v9', create_time: nowS(), view_count: 4321 }] }),
      () => ok({ videos: [] }),
    ])
    await expect(provider.insights('acc', 'v9')).resolves.toEqual({ views: 4321, reach: null })
    await expect(provider.insights('acc', 'v9')).rejects.toThrow(/no view_count/)
  })

  it('refreshes with the refresh token and rotates it', async () => {
    const calls = scriptFetch([
      () => ({ access_token: 'acc2', expires_in: 86400, refresh_token: 'ref2', refresh_expires_in: 1, open_id: 'o1', scope: '', token_type: 'Bearer' }),
    ])
    const next = await provider.refresh('acc', 'ref')
    const body = calls[0]?.init?.body as URLSearchParams
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('ref')
    expect(next).toMatchObject({ token: 'acc2', refreshToken: 'ref2' })
    await expect(provider.refresh('acc', null)).rejects.toThrow(/refresh token/)
  })

  it('surfaces TikTok error envelopes', async () => {
    scriptFetch([() => ({ data: {}, error: { code: 'access_token_invalid', message: 'expired' } })])
    await expect(provider.profile('bad')).rejects.toThrow(/access_token_invalid/)
  })
})

describe('provider registry', () => {
  afterEach(() => {
    setProviderFor('INSTAGRAM', null)
    setProviderFor('TIKTOK', null)
  })

  it('maps slugs both ways', () => {
    expect(platformSlug('TIKTOK')).toBe('tiktok')
    expect(platformSlug('INSTAGRAM')).toBe('instagram')
    expect(platformFromSlug('tiktok')).toBe('TIKTOK')
    expect(platformFromSlug('facebook')).toBeNull()
  })

  it('serves platform-specific fakes under NOD_FAKE_PROVIDERS', async () => {
    const ig = providerFor('INSTAGRAM')
    const tt = providerFor('TIKTOK')
    expect(ig).not.toBe(tt)
    expect(tt.authUrl('s1')).toBe('/api/auth/tiktok/callback?code=fake_s1&state=s1')
    expect(ig.authUrl('s1')).toBe('/api/auth/instagram/callback?code=fake_s1&state=s1')

    const account = await tt.exchangeCode('fake_lisa')
    expect(account.accountType).toBe('creator')
    expect(account.refreshToken).toMatch(/^fake-refresh-/)
    expect(account.platformUserId).toMatch(/^fake_tt_/)
  })

  it('lets tests swap a single platform', () => {
    const custom = new FakeSocialProvider('tiktok')
    setProviderFor('TIKTOK', custom)
    expect(providerFor('TIKTOK')).toBe(custom)
    expect(providerFor('INSTAGRAM')).not.toBe(custom)
  })
})
