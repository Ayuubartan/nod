/**
 * Public post URL → (platform, post id, canonical URL). Pure and synchronous: this runs
 * inside the submit request (docs/14 D7) so it must never touch the network.
 *
 * Supported (docs/14 D8):
 *   TikTok     https://www.tiktok.com/@handle/video/7234567890123456789
 *              https://www.tiktok.com/@handle/photo/7234567890123456789
 *              https://m.tiktok.com/v/7234567890123456789.html
 *   Instagram  https://www.instagram.com/reel/C1a2B3c4D5e/
 *              https://www.instagram.com/reels/C1a2B3c4D5e/
 *              https://www.instagram.com/p/C1a2B3c4D5e/
 *              https://www.instagram.com/<user>/reel/C1a2B3c4D5e/
 *
 * Short links (vm.tiktok.com, vt.tiktok.com) need a redirect to resolve; we ask the
 * creator for the full link instead of following redirects from a request handler.
 */

import type { AccountPlatform } from '@prisma/client'

export type ParsedPostUrl = {
  platform: AccountPlatform
  /** TikTok video id (digits) or Instagram shortcode. Stable for the life of the post. */
  postId: string
  canonicalUrl: string
  mediaType: 'video' | 'photo' | 'reel' | 'post'
}

export type PostUrlError = 'INVALID_URL' | 'UNSUPPORTED_HOST' | 'SHORT_LINK' | 'STORY' | 'NO_POST_ID'

export class PostUrlParseError extends Error {
  constructor(readonly code: PostUrlError) {
    super(`Could not parse post URL: ${code}`)
    this.name = 'PostUrlParseError'
  }
}

const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'])
const TIKTOK_SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com'])
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com'])

export function parsePostUrl(raw: string): ParsedPostUrl {
  let url: URL
  try {
    const trimmed = raw.trim()
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    throw new PostUrlParseError('INVALID_URL')
  }

  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)

  if (TIKTOK_SHORT_HOSTS.has(host)) throw new PostUrlParseError('SHORT_LINK')

  if (TIKTOK_HOSTS.has(host)) {
    // /@handle/video/<id>, /@handle/photo/<id>, /v/<id>.html
    const kindIndex = segments.findIndex((s) => s === 'video' || s === 'photo')
    if (kindIndex >= 0) {
      const id = segments[kindIndex + 1]?.match(/^\d{6,}/)?.[0]
      if (!id) throw new PostUrlParseError('NO_POST_ID')
      const handle = segments[0]?.startsWith('@') ? segments[0] : '@'
      const kind = segments[kindIndex] as 'video' | 'photo'
      return {
        platform: 'TIKTOK',
        postId: id,
        canonicalUrl: `https://www.tiktok.com/${handle}/${kind}/${id}`,
        mediaType: kind,
      }
    }
    if (segments[0] === 'v') {
      const id = segments[1]?.match(/^\d{6,}/)?.[0]
      if (!id) throw new PostUrlParseError('NO_POST_ID')
      return { platform: 'TIKTOK', postId: id, canonicalUrl: `https://www.tiktok.com/@/video/${id}`, mediaType: 'video' }
    }
    throw new PostUrlParseError('NO_POST_ID')
  }

  if (INSTAGRAM_HOSTS.has(host)) {
    if (segments.includes('stories')) throw new PostUrlParseError('STORY')
    const kindIndex = segments.findIndex((s) => s === 'reel' || s === 'reels' || s === 'p' || s === 'tv')
    if (kindIndex < 0) throw new PostUrlParseError('NO_POST_ID')
    const code = segments[kindIndex + 1]
    if (!code || !/^[A-Za-z0-9_-]{5,}$/.test(code)) throw new PostUrlParseError('NO_POST_ID')
    const isReel = segments[kindIndex] === 'reel' || segments[kindIndex] === 'reels'
    return {
      platform: 'INSTAGRAM',
      postId: code,
      canonicalUrl: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/`,
      mediaType: isReel ? 'reel' : 'post',
    }
  }

  throw new PostUrlParseError('UNSUPPORTED_HOST')
}

/** Non-throwing variant for form validation. */
export function tryParsePostUrl(raw: string): { ok: true; value: ParsedPostUrl } | { ok: false; code: PostUrlError } {
  try {
    return { ok: true, value: parsePostUrl(raw) }
  } catch (error) {
    if (error instanceof PostUrlParseError) return { ok: false, code: error.code }
    return { ok: false, code: 'INVALID_URL' }
  }
}
