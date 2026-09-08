/**
 * PostHog — docs/06 section 8.
 *
 * Rule from the spec: "identify by User.id, never by handle or email in properties."
 * `scrub()` below is the enforcement point; every capture goes through it.
 */

import posthog from 'posthog-js'

const FORBIDDEN_PROPERTY_KEYS = [
  'email',
  'handle',
  'phone',
  'swish',
  'swishnumber',
  'personnummer',
  'ssn',
  'token',
  'accesstoken',
  'subject',
  'subjecthash',
  'name',
]

/** Strips anything that identifies a person by something other than their User.id. */
export function scrub(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (FORBIDDEN_PROPERTY_KEYS.includes(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

/** Buckets a number so the estimator can be analysed without storing exact inputs. */
export function bucket(value: number, edges: number[]): string {
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!
    if (value < edge) return i === 0 ? `<${edge}` : `${edges[i - 1]}-${edge}`
  }
  return `${edges[edges.length - 1]}+`
}

export const FOLLOWER_BUCKETS = [300, 1_000, 5_000, 20_000]
export const VIEW_BUCKETS = [100, 500, 1_000, 5_000]

let initialised = false

export function initAnalytics(): void {
  if (initialised || typeof window === 'undefined') return
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (!key) return
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: true,
    autocapture: false,
    // No ad pixels, minimal cookie footprint (docs/07 section 7).
    persistence: 'localStorage+cookie',
  })
  initialised = true
}

export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    if (process.env.NODE_ENV === 'development') {
      console.debug('[analytics]', event, scrub(properties))
    }
    return
  }
  posthog.capture(event, scrub(properties))
}

export function identify(userId: string, properties: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined' || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return
  posthog.identify(userId, scrub(properties))
}

/** Event names used across the product — docs/01 tech notes, docs/02 onboarding. */
export const EVENTS = {
  waitlistViewed: 'waitlist_viewed',
  estimatorUsed: 'estimator_used',
  waitlistSubmitted: 'waitlist_submitted',
  waitlistOpenAccount: 'waitlist_open_account',
  referralLinkCopied: 'referral_link_copied',
  brandEnquirySubmitted: 'brand_enquiry_submitted',
  onboardingStepViewed: 'onboarding_step_viewed',
  onboardingStepCompleted: 'onboarding_step_completed',
  onboardingCompleted: 'onboarding_completed',
  creatorSwitchAccepted: 'creator_switch_accepted',
  creatorSwitchSkipped: 'creator_switch_skipped',
  bankidStarted: 'bankid_started',
  bankidCompleted: 'bankid_completed',
  campaignViewed: 'campaign_viewed',
  claimStarted: 'claim_started',
  claimCompleted: 'claim_completed',
  uploadCompleted: 'upload_completed',
  regionPicked: 'region_picked',
  placementApproved: 'placement_approved',
  placementRegenerated: 'placement_regenerated',
  placementRejected: 'placement_rejected',
  postUrlSubmitted: 'post_url_submitted',
  earningsCardShared: 'earnings_card_shared',
} as const
