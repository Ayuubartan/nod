/**
 * Social provider registry — one read-only provider per `AccountPlatform` (docs/06
 * sections 1 and 2). Anything holding a SocialAccount goes through here so a TikTok
 * account never gets asked about through the Instagram Graph API.
 */

import type { AccountPlatform } from '@prisma/client'
import { FakeSocialProvider, instagramUsesFake, setSocialProvider, socialProvider } from './instagram'
import { TikTokProvider } from './tiktok'
import type { SocialProvider } from './types'

export const PLATFORMS: readonly AccountPlatform[] = ['INSTAGRAM', 'TIKTOK']

export const isPlatform = (value: string): value is AccountPlatform =>
  (PLATFORMS as readonly string[]).includes(value)

/** URL segment used by the OAuth routes: `/api/auth/instagram/...`. */
export const platformSlug = (platform: AccountPlatform): 'instagram' | 'tiktok' =>
  platform === 'TIKTOK' ? 'tiktok' : 'instagram'

export const platformFromSlug = (slug: string): AccountPlatform | null =>
  slug === 'instagram' ? 'INSTAGRAM' : slug === 'tiktok' ? 'TIKTOK' : null

/** True when the TikTok flow runs against the fake (no TikTok app configured). */
export const tiktokUsesFake = () => process.env.NOD_FAKE_PROVIDERS === '1' || !process.env.TIKTOK_CLIENT_KEY

let tiktokCached: SocialProvider | null = null

export function providerFor(platform: AccountPlatform): SocialProvider {
  if (platform === 'INSTAGRAM') return socialProvider()
  if (tiktokCached) return tiktokCached
  tiktokCached = tiktokUsesFake() ? new FakeSocialProvider('tiktok') : new TikTokProvider()
  return tiktokCached
}

/**
 * Whether connecting on this platform is a real OAuth redirect or the fake's inline
 * handle prompt (local dev and tests walk onboarding without developer apps).
 */
export function usesFake(platform: AccountPlatform): boolean {
  return platform === 'INSTAGRAM' ? instagramUsesFake() : tiktokUsesFake()
}

/** Test seam: swap the provider for a platform (null restores the default). */
export function setProviderFor(platform: AccountPlatform, provider: SocialProvider | null): void {
  if (platform === 'INSTAGRAM') setSocialProvider(provider)
  else tiktokCached = provider
}
