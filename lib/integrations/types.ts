/**
 * Integration interfaces — docs/06.
 *
 * "Every integration lives behind an interface with (a) a real implementation, (b) a
 * fake for tests, and (c) where marked, a manual/ops implementation for the pilot.
 * Build the interface and the manual path first."
 */

export type Media = {
  id: string
  caption: string | null
  mediaType: 'IMAGE' | 'VIDEO' | 'STORY' | 'REEL' | 'CAROUSEL'
  permalink: string | null
  timestamp: string
  /** Present only where the platform exposes it. */
  isPaidPartnership?: boolean
  /** Perceptual hash of the published media, when NOD could fetch it. */
  perceptualHash?: string
}

export type SocialToken = {
  token: string
  refreshToken?: string
  expiresAt: Date | null
}

export type SocialProfile = {
  followers: number
  avgViews30d: number
  categories?: string[]
}

export type ConnectedAccount = {
  platformUserId: string
  handle: string
  accountType: 'personal' | 'creator' | 'business'
  isPrivate: boolean
  token: string
  refreshToken?: string
  expiresAt: Date | null
}

export interface SocialProvider {
  readonly name: string
  authUrl(state: string): string
  exchangeCode(code: string): Promise<ConnectedAccount>
  profile(token: string): Promise<SocialProfile>
  recentMedia(token: string, since: Date): Promise<Media[]>
  insights(token: string, mediaId: string): Promise<{ views: number; reach: number | null }>
  /**
   * Mint a fresh access token. Instagram refreshes the long-lived token itself; TikTok
   * needs the separate refresh token, so both are passed and each provider uses what it
   * needs.
   */
  refresh(token: string, refreshToken?: string | null): Promise<SocialToken>
}

// ---------------------------------------------------------------- identity

export type IdentityStart = { url: string; reference: string }
export type IdentityResult = { subject: string; birthYear: number; provider: string }

export interface IdentityProvider {
  readonly name: string
  start(userId: string, returnUrl: string): Promise<IdentityStart>
  complete(callbackPayload: Record<string, string>): Promise<IdentityResult>
}

// ---------------------------------------------------------------- placement engine

export type Region = { x: number; y: number; w: number; h: number; label?: string }

export type RenderResult = {
  resultPath: string
  engine: string
  params?: Record<string, unknown>
  /** True when a human has to finish the job (the pilot's ops queue). */
  deferred: boolean
}

export interface PlacementEngine {
  readonly name: string
  candidates(imagePath: string): Promise<Region[]>
  render(args: {
    placementId: string
    imagePath: string
    region: Region
    assetPath: string
    params?: Record<string, unknown>
  }): Promise<RenderResult>
}

// ---------------------------------------------------------------- payouts

export type PayoutRow = {
  walletId: string
  userId: string
  swishNumber: string
  amountOre: number
  memo: string
}

export type PayoutResult = {
  walletId: string
  ok: boolean
  reference?: string
  error?: string
}

export interface PayoutProvider {
  readonly name: string
  send(batchId: string, rows: PayoutRow[]): Promise<PayoutResult[]>
}

// ---------------------------------------------------------------- deposits

export interface DepositProvider {
  readonly name: string
  createCheckout(args: {
    campaignId: string
    amountOre: number
    brandEmail: string
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string; sessionId: string }>
  refund(args: { paymentRef: string; amountOre: number }): Promise<{ reference: string }>
}
