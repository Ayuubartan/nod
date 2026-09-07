/**
 * Instagram — read-only.
 *
 * VERIFIED: 2026-09-07 against Meta's live documentation (docs/06 preamble).
 *   - Business Login, scopes and endpoints:
 *     https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
 *     https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 *   - Media insights metrics and required permission:
 *     https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights
 *
 * What that check confirmed, and what it changes for NOD:
 *
 *   - `instagram_business_manage_insights` is the correct scope for media insights on
 *     the Instagram-Login flow (the Facebook-Login flow uses `instagram_manage_insights`,
 *     which NOD does not use).
 *   - `views` is a real metric and is available on Stories, Reels and feed posts. It is
 *     the right one to bill on. `impressions` is deprecated for media created after
 *     2 July 2024, so NOD must never fall back to it.
 *   - The API returns nothing for media owned by personal accounts, which is exactly why
 *     the CONNECTED_SCREENSHOT tier exists (docs/03 SocialAccount sub-states).
 *   - Meta documents that some metrics are unavailable on accounts with fewer than 100
 *     followers. NOD's eligibility floor is 300 followers (docs/05), so the floor sits
 *     above that boundary — but see `insights()` for how a missing metric is handled.
 *
 * CLAUDE.md rule 6: NOD never posts on a user's behalf. The scope list below contains
 * no publishing permission — notably not `instagram_business_content_publish`, which is
 * the one Meta offers for it — and `assertNoWriteScopes` fails at module load if one is
 * ever added.
 */

import { hashSubject } from '@/lib/crypto'
import type { ConnectedAccount, Media, SocialProfile, SocialProvider, SocialToken } from './types'

/**
 * Read-only scopes only — verified 2026-09-07 (see the file header).
 * Meta's full set also includes `instagram_business_content_publish`,
 * `instagram_business_manage_messages` and `instagram_business_manage_comments`.
 * NOD requests none of them, by rule.
 */
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
   *
   * Asks for `views` and `reach` only. Both are documented on Stories, Reels and feed
   * posts, so one request shape covers every content type NOD supports. `impressions`
   * is deliberately not requested: Meta deprecated it for media created after
   * 2 July 2024, and billing a brand on a deprecated metric is not a position to be in.
   *
   * A metric Meta declines to return (small accounts, or a media type that does not
   * carry it) comes back absent rather than zero. Returning 0 views would silently
   * qualify a placement at the view floor and underpay the participant, so an absent
   * `views` throws and the placement falls to the ops verification queue instead.
   */
  async insights(token: string, mediaId: string): Promise<{ views: number; reach: number | null }> {
    const response = await this.get<{ data: Array<{ name: string; values: Array<{ value: number }> }> }>(
      `${GRAPH}/${mediaId}/insights?metric=views,reach&access_token=${token}`,
    )

    const byName = new Map(response.data.map((m) => [m.name, m.values[0]?.value]))
    const views = byName.get('views')

    if (typeof views !== 'number') {
      throw new Error(`Instagram returned no "views" metric for media ${mediaId}`)
    }

    return { views, reach: byName.get('reach') ?? null }
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
