/**
 * TikTok — read-only.
 *
 * VERIFIED: 2026-09-09 against TikTok for Developers (docs/06 preamble).
 *   - Login Kit (web) and the OAuth v2 endpoints:
 *     https://developers.tiktok.com/doc/login-kit-web
 *     https://developers.tiktok.com/doc/oauth-user-access-token-management
 *   - Display API user info and video list/query:
 *     https://developers.tiktok.com/doc/display-api-get-user-info
 *     https://developers.tiktok.com/doc/display-api-get-user-videos
 *     https://developers.tiktok.com/doc/display-api-query-videos
 *
 * What that check confirmed, and what it changes for NOD:
 *
 *   - Scopes are dot-separated. `user.info.basic` (open_id, display name, avatar),
 *     `user.info.profile` (username, verified flag), `user.info.stats` (follower,
 *     like and video counts) and `video.list` (the user's own public videos, with
 *     `view_count`) are the four read scopes. `video.publish` and `video.upload` are the
 *     write scopes; NOD never requests them (CLAUDE.md rule 6).
 *   - Access tokens live 24 hours, refresh tokens 365 days. Every refresh returns a new
 *     refresh token too, so both are stored and rotated together.
 *   - `video.list` / `video.query` only return the user's *public* videos, and view
 *     counts on them are the same public number shown in the app. There is no per-video
 *     insights endpoint like Instagram's; the public count is what NOD bills on.
 *   - Display API access to users outside the developer's own test list requires the
 *     app to pass TikTok's audit. Until it does, only sandbox test users can connect.
 *
 * DECISION: TikTok has no business/creator account split that the Display API exposes,
 * and `video.list` works for any account that has public videos. Every connected TikTok
 * account is therefore typed `creator` and lands in CONNECTED_API when it is above the
 * floor; an account whose videos are all private is flagged `isPrivate`.
 */

import type { ConnectedAccount, Media, SocialProfile, SocialProvider, SocialToken } from './types'

/** Read-only scopes only — verified 2026-09-09 (see the file header). */
const SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'] as const

const WRITE_SCOPE_MARKERS = ['publish', 'upload', 'write', 'manage']

export function assertNoWriteScopes(scopes: readonly string[]): void {
  const offending = scopes.filter((s) => WRITE_SCOPE_MARKERS.some((marker) => s.includes(marker)))
  if (offending.length > 0) {
    throw new Error(
      `NOD must never request a write scope on a social API (CLAUDE.md rule 6). Offending: ${offending.join(', ')}`,
    )
  }
}

assertNoWriteScopes(SCOPES)

export const TIKTOK_SCOPES: readonly string[] = SCOPES

const AUTH = 'https://www.tiktok.com/v2/auth/authorize/'
const API = 'https://open.tiktokapis.com/v2'

const USER_FIELDS = 'open_id,union_id,display_name,username,is_verified,follower_count,likes_count,video_count'
const VIDEO_FIELDS = 'id,create_time,title,video_description,share_url,view_count,like_count,duration'

type TokenResponse = {
  access_token: string
  expires_in: number
  refresh_token: string
  refresh_expires_in: number
  open_id: string
  scope: string
  token_type: string
}

type UserInfo = {
  open_id: string
  union_id?: string
  display_name?: string
  username?: string
  is_verified?: boolean
  follower_count?: number
  likes_count?: number
  video_count?: number
}

type Video = {
  id: string
  create_time: number
  title?: string
  video_description?: string
  share_url?: string
  view_count?: number
  like_count?: number
  duration?: number
}

type Envelope<T> = { data: T; error?: { code: string; message: string; log_id?: string } }

export class TikTokProvider implements SocialProvider {
  readonly name = 'tiktok'

  constructor(
    private readonly clientKey = process.env.TIKTOK_CLIENT_KEY ?? '',
    private readonly clientSecret = process.env.TIKTOK_CLIENT_SECRET ?? '',
    private readonly redirectUri = process.env.TIKTOK_REDIRECT_URI ?? '',
  ) {}

  authUrl(state: string): string {
    const params = new URLSearchParams({
      client_key: this.clientKey,
      response_type: 'code',
      scope: SCOPES.join(','),
      redirect_uri: this.redirectUri,
      state,
    })
    return `${AUTH}?${params.toString()}`
  }

  async exchangeCode(code: string): Promise<ConnectedAccount> {
    const token = await this.token({
      client_key: this.clientKey,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
    })

    const me = await this.userInfo(token.access_token)
    const videos = await this.videos(token.access_token, 1).catch(() => [])

    return {
      platformUserId: me.open_id,
      handle: me.username || me.display_name || me.open_id,
      accountType: 'creator',
      // Having videos but none listable is the only privacy signal the API gives (a
      // private account's videos are never listed). See the DECISION in the file header.
      isPrivate: (me.video_count ?? 0) > 0 && videos.length === 0,
      token: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
    }
  }

  async profile(token: string): Promise<SocialProfile> {
    const me = await this.userInfo(token)

    // No field reports a 30-day average; derive it from the public view counts of the
    // videos posted in the window, the same way the Instagram provider does.
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000
    const recent = (await this.videos(token, 20)).filter((v) => v.create_time * 1000 >= since)
    const counted = recent.filter((v) => typeof v.view_count === 'number')
    const total = counted.reduce((sum, v) => sum + (v.view_count ?? 0), 0)

    return {
      followers: me.follower_count ?? 0,
      avgViews30d: counted.length > 0 ? Math.round(total / counted.length) : 0,
    }
  }

  async recentMedia(token: string, since: Date): Promise<Media[]> {
    const videos = await this.videos(token, 20)
    return videos.map(toMedia).filter((item) => new Date(item.timestamp) >= since)
  }

  /**
   * TikTok exposes no insights endpoint; the public `view_count` on the video itself is
   * the number. A video that `video.query` does not return is gone (or made private),
   * which throws here so the pipeline treats it as not live, exactly like Instagram.
   */
  async insights(token: string, mediaId: string): Promise<{ views: number; reach: number | null }> {
    const response = await this.post<Envelope<{ videos?: Video[] }>>(
      `${API}/video/query/?fields=${VIDEO_FIELDS}`,
      token,
      { filters: { video_ids: [mediaId] } },
    )
    const video = response.data.videos?.find((v) => String(v.id) === mediaId)
    if (!video || typeof video.view_count !== 'number') {
      throw new Error(`TikTok returned no view_count for video ${mediaId}`)
    }
    return { views: video.view_count, reach: null }
  }

  async refresh(_token: string, refreshToken?: string | null): Promise<SocialToken> {
    if (!refreshToken) throw new Error('TikTok refresh needs the refresh token')
    const next = await this.token({
      client_key: this.clientKey,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    return {
      token: next.access_token,
      refreshToken: next.refresh_token,
      expiresAt: new Date(Date.now() + next.expires_in * 1000),
    }
  }

  // ---------------------------------------------------------------- http

  private async token(fields: Record<string, string>): Promise<TokenResponse> {
    const response = await fetch(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`TikTok token request failed: ${response.status}`)
    const json = (await response.json()) as TokenResponse & { error?: string; error_description?: string }
    if (json.error || !json.access_token) throw new Error(`TikTok token error: ${json.error ?? 'no access_token'}`)
    return json
  }

  private async userInfo(token: string): Promise<UserInfo> {
    const response = await this.get<Envelope<{ user: UserInfo }>>(`${API}/user/info/?fields=${USER_FIELDS}`, token)
    return response.data.user
  }

  private async videos(token: string, max: number): Promise<Video[]> {
    const response = await this.post<Envelope<{ videos?: Video[]; cursor?: number; has_more?: boolean }>>(
      `${API}/video/list/?fields=${VIDEO_FIELDS}`,
      token,
      { max_count: Math.min(Math.max(max, 1), 20) },
    )
    return response.data.videos ?? []
  }

  private async get<T>(url: string, token: string): Promise<T> {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (!response.ok) throw new Error(`TikTok GET failed: ${response.status}`)
    return this.unwrap<T>(await response.json())
  }

  private async post<T>(url: string, token: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`TikTok POST failed: ${response.status}`)
    return this.unwrap<T>(await response.json())
  }

  /** TikTok answers 200 with `error.code = "ok"` on success and a real code otherwise. */
  private unwrap<T>(json: unknown): T {
    const envelope = json as { error?: { code?: string; message?: string } }
    if (envelope.error?.code && envelope.error.code !== 'ok') {
      throw new Error(`TikTok API error ${envelope.error.code}: ${envelope.error.message ?? ''}`)
    }
    return json as T
  }
}

function toMedia(video: Video): Media {
  return {
    id: String(video.id),
    caption: video.video_description ?? video.title ?? null,
    mediaType: 'VIDEO',
    permalink: video.share_url ?? null,
    timestamp: new Date(video.create_time * 1000).toISOString(),
  }
}
