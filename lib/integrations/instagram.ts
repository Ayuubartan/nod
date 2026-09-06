/**
 * Instagram — read-only.
 *
 * VERIFIED: not yet against live Meta docs. Before enabling the real implementation,
 * read the current "Instagram API with Instagram Login" reference, confirm the scope
 * names and the insights metric names for each media type, and record the date and the
 * doc URL here. Do not implement from memory (docs/06 preamble).
 *
 * CLAUDE.md rule 6: NOD never posts on a user's behalf. The scope list below contains
 * no publishing permission, and `assertNoWriteScopes` fails the build path if one is
 * ever added.
 */

import { hashSubject } from '@/lib/crypto'
import type { ConnectedAccount, Media, SocialProfile, SocialProvider, SocialToken } from './types'

/** Read-only scopes only. Adding a publish scope here throws at startup. */
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'] as const

const WRITE_SCOPE_MARKERS = ['publish', 'content_publish', 'manage_comments', 'manage_messages', 'write']

export function assertNoWriteScopes(scopes: readonly string[]): void {
  const offending = scopes.filter((s) => WRITE_SCOPE_MARKERS.some((marker) => s.includes(marker)))
  if (offending.length > 0) {
    throw new Error(
      `NOD must never request a write scope on a social API (CLAUDE.md rule 6). Offending: ${offending.join(', ')}`,
    )
  }
}

assertNoWriteScopes(SCOPES)

const GRAPH = 'https://graph.instagram.com'
const AUTH = 'https://www.instagram.com/oauth/authorize'

export class InstagramProvider implements SocialProvider {
  readonly name = 'instagram'

  constructor(
    private readonly appId = process.env.META_APP_ID ?? '',
    private readonly appSecret = process.env.META_APP_SECRET ?? '',
    private readonly redirectUri = process.env.META_REDIRECT_URI ?? '',
  ) {}

  authUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(','),
      state,
    })
    return `${AUTH}?${params.toString()}`
  }

  async exchangeCode(code: string): Promise<ConnectedAccount> {
    const form = new URLSearchParams({
      client_id: this.appId,
      client_secret: this.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
      code,
    })

    const shortLived = await this.post<{ access_token: string; user_id: string }>(
      'https://api.instagram.com/oauth/access_token',
      form,
    )

    // Short-lived tokens last an hour; exchange immediately for a 60-day token.
    const longLived = await this.get<{ access_token: string; expires_in: number }>(
      `${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${this.appSecret}&access_token=${shortLived.access_token}`,
    )

    const me = await this.get<{
      id: string
      username: string
      account_type?: string
      media_count?: number
    }>(`${GRAPH}/me?fields=id,username,account_type,media_count&access_token=${longLived.access_token}`)

    const accountType =
      me.account_type === 'BUSINESS' ? 'business' : me.account_type === 'MEDIA_CREATOR' ? 'creator' : 'personal'

    return {
      platformUserId: me.id,
      handle: me.username,
      accountType,
      isPrivate: false,
      token: longLived.access_token,
      expiresAt: new Date(Date.now() + longLived.expires_in * 1000),
    }
  }

  async profile(token: string): Promise<SocialProfile> {
    const me = await this.get<{ followers_count?: number }>(
      `${GRAPH}/me?fields=followers_count&access_token=${token}`,
    )

    // Average views over the last 30 days, computed from recent media insights rather
    // than a single API field, because no field reports it directly.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const media = await this.recentMedia(token, since)
    let total = 0
    let counted = 0
    for (const item of media.slice(0, 20)) {
      try {
        const { views } = await this.insights(token, item.id)
        total += views
        counted += 1
      } catch {
        // A single media without insights must not fail the whole profile pull.
      }
    }

    return {
      followers: me.followers_count ?? 0,
      avgViews30d: counted > 0 ? Math.round(total / counted) : 0,
    }
  }

  async recentMedia(token: string, since: Date): Promise<Media[]> {
    const fields = 'id,caption,media_type,permalink,timestamp'
    const response = await this.get<{ data: Array<Record<string, string>> }>(
      `${GRAPH}/me/media?fields=${fields}&limit=50&access_token=${token}`,
    )

    return response.data
      .map((item) => ({
        id: String(item.id),
        caption: item.caption ?? null,
        mediaType: (item.media_type as Media['mediaType']) ?? 'IMAGE',
        permalink: item.permalink ?? null,
        timestamp: item.timestamp ?? new Date().toISOString(),
      }))
      .filter((item) => new Date(item.timestamp) >= since)
  }

  /**
   * Story insights are only readable while the Story is alive, so the hold-end job
   * schedules the pull at holdEndsAt minus 30 minutes (docs/06 section 1).
   */
  async insights(token: string, mediaId: string): Promise<{ views: number; reach: number | null }> {
    const response = await this.get<{ data: Array<{ name: string; values: Array<{ value: number }> }> }>(
      `${GRAPH}/${mediaId}/insights?metric=views,reach&access_token=${token}`,
    )
    const byName = new Map(response.data.map((m) => [m.name, m.values[0]?.value ?? 0]))
    return { views: byName.get('views') ?? 0, reach: byName.get('reach') ?? null }
  }

  async refresh(token: string): Promise<SocialToken> {
    const response = await this.get<{ access_token: string; expires_in: number }>(
      `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`,
    )
    return { token: response.access_token, expiresAt: new Date(Date.now() + response.expires_in * 1000) }
  }

  private async get<T>(url: string): Promise<T> {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Instagram GET failed: ${response.status}`)
    return (await response.json()) as T
  }

  private async post<T>(url: string, body: URLSearchParams): Promise<T> {
    const response = await fetch(url, { method: 'POST', body, cache: 'no-store' })
    if (!response.ok) throw new Error(`Instagram POST failed: ${response.status}`)
    return (await response.json()) as T
  }
}

/**
 * Pilot fallback — docs/06 section 1: "ManualSocialProvider where ops enters followers /
 * avg views from a screenshot and view counts at hold end."
 *
 * Connecting still records the handle so the account exists; everything numeric comes
 * from ops through the verification queue, so `profile` and `insights` deliberately
 * return zeroes rather than guessing.
 */
export class ManualSocialProvider implements SocialProvider {
  readonly name = 'manual'

  authUrl(state: string): string {
    return `/onboarding/connect/manual?state=${encodeURIComponent(state)}`
  }

  async exchangeCode(code: string): Promise<ConnectedAccount> {
    const handle = code.replace(/^@/, '').trim()
    return {
      platformUserId: `manual:${hashSubject(handle).slice(0, 24)}`,
      handle,
      accountType: 'personal',
      isPrivate: true,
      token: '',
      expiresAt: null,
    }
  }

  async profile(): Promise<SocialProfile> {
    return { followers: 0, avgViews30d: 0 }
  }

  async recentMedia(): Promise<Media[]> {
    return []
  }

  async insights(): Promise<{ views: number; reach: number | null }> {
    return { views: 0, reach: null }
  }

  async refresh(token: string): Promise<SocialToken> {
    return { token, expiresAt: null }
  }
}

/**
 * Deterministic fake for tests and local development. Derives plausible numbers from
 * the handle so the same handle always produces the same account.
 */
export class FakeSocialProvider implements SocialProvider {
  readonly name = 'fake'

  private mediaStore = new Map<string, Media[]>()
  private viewStore = new Map<string, number>()

  authUrl(state: string): string {
    return `/api/auth/instagram/callback?code=fake_${state}&state=${state}`
  }

  async exchangeCode(code: string): Promise<ConnectedAccount> {
    const handle = code.replace(/^fake_/, '').slice(0, 20) || 'testuser'
    const seed = [...handle].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
    return {
      platformUserId: `fake_${seed}`,
      handle,
      // Deterministic split so tests can exercise both onboarding branches.
      accountType: seed % 2 === 0 ? 'creator' : 'personal',
      isPrivate: seed % 5 === 0,
      token: `fake-token-${seed}`,
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    }
  }

  async profile(token: string): Promise<SocialProfile> {
    const seed = Number(token.split('-').pop() ?? 0)
    const followers = 300 + (seed % 40) * 120
    return { followers, avgViews30d: Math.round(followers * 0.55), categories: ['food'] }
  }

  async recentMedia(token: string): Promise<Media[]> {
    return this.mediaStore.get(token) ?? []
  }

  async insights(_token: string, mediaId: string): Promise<{ views: number; reach: number | null }> {
    const views = this.viewStore.get(mediaId) ?? 450
    return { views, reach: Math.round(views * 0.9) }
  }

  async refresh(token: string): Promise<SocialToken> {
    return { token, expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) }
  }

  // --- test helpers
  setMedia(token: string, media: Media[]): void {
    this.mediaStore.set(token, media)
  }

  setViews(mediaId: string, views: number): void {
    this.viewStore.set(mediaId, views)
  }
}

const shouldUseFakes = () => process.env.NOD_FAKE_PROVIDERS === '1' || !process.env.META_APP_ID

let cached: SocialProvider | null = null

export function socialProvider(): SocialProvider {
  if (cached) return cached
  cached = shouldUseFakes() ? new FakeSocialProvider() : new InstagramProvider()
  return cached
}

/** Test seam: swap the provider for a specific instance. */
export function setSocialProvider(provider: SocialProvider | null): void {
  cached = provider
}
