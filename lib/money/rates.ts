/**
 * Pilot price card — docs/05-pricing.md.
 *
 * This file is the single source of truth for every number with a currency on it.
 * The landing-page estimator, the campaign builder, the payout calculator and the
 * reservation formula all import from here. Nothing hardcodes a price anywhere else.
 *
 * All money is Int in öre (SEK x 100). Never float, never string math.
 *
 * Defaults and floors are also seeded into the `Flag` table so ops can change them
 * without a deploy; `lib/flags.ts` reads the flag and falls back to these constants.
 */

export const ORE_PER_SEK = 100

export const sek = (kr: number): number => Math.round(kr * ORE_PER_SEK)

/** Brand-facing defaults. The brand sets its own numbers above the floors. */
export const DEFAULTS = {
  /** per 1,000 qualified views, all-in */
  cpmOre: sek(60),
  /** per approved placement, all-in */
  fixedOre: sek(30),
  /** Hybrid+bonus template */
  bonusOre: sek(50),
  bonusAtViews: 5_000,
  /** below this many qualified views the placement pays the fixed component only */
  viewFloor: 100,
  /** NOD's spread, in basis points. Snapshotted onto PayoutTemplate at funding. */
  takeRateBps: 2800,
  /** placements per participant per campaign, across all their accounts */
  perPersonCap: 2,
  /** caps the reservation, brand-adjustable */
  perPlacementMaxOre: sek(500),
  /** invoice, net-30 */
  creditTermsFeeBps: 400,
  /** wallet pays out once available balance reaches this */
  payoutThresholdOre: sek(100),
  /** paid to the referrer from NOD margin, not campaign budget */
  referralBonusOre: sek(25),
} as const

export const FLOORS = {
  cpmOre: sek(40),
  fixedOre: sek(20),
  viewFloor: 50,
  perPersonCap: 1,
  /** account eligibility floor — docs/03 SocialAccount sub-states */
  minFollowers: 300,
  minAvgViews: 100,
} as const

/** Reservation covers 2x the account's recent average, so over-performance is free reach. */
export const RESERVATION_VIEW_MULTIPLIER = 2

/** Hold windows before verification runs — docs/03 P-08. */
export const HOLD_MS = {
  story: 24 * 60 * 60 * 1000,
  reel: 7 * 24 * 60 * 60 * 1000,
  post: 7 * 24 * 60 * 60 * 1000,
} as const

/** Every timed placement state — docs/03 P-01..P-07. */
export const TIMEOUT_MS = {
  claim: 48 * 60 * 60 * 1000,
  participantReview: 24 * 60 * 60 * 1000,
  brandReview: 24 * 60 * 60 * 1000,
  approvedToPublish: 48 * 60 * 60 * 1000,
  /** disclosure fix window — docs/03 verification check 2 */
  disclosureFix: 12 * 60 * 60 * 1000,
  /** generation SLA in the pilot (ops queue); clock is paused while GENERATING */
  generationSla: 4 * 60 * 60 * 1000,
  /** token expiry mid-hold pauses the hold clock for at most this long — edge case 7 */
  tokenDisconnectGrace: 72 * 60 * 60 * 1000,
  /** brand dispute window after the final report */
  disputeWindow: 7 * 24 * 60 * 60 * 1000,
  /** AWAITING_FUNDS expiry back to DRAFT */
  awaitingFunds: 14 * 24 * 60 * 60 * 1000,
  /** idle DRAFT campaigns are deleted */
  draftIdle: 30 * 24 * 60 * 60 * 1000,
} as const

export const LIMITS = {
  /** docs/03 P-05 — "Regenerate (counter shows 3 left)" */
  maxRegens: 3,
  /** docs/03 P-06 — brand may bounce a placement back to POSITIONED once */
  maxBrandBounces: 1,
  /** docs/03 P-04 — retry x2 then escalate to ops */
  maxGenerationRetries: 2,
  /** Tier A auto-approves and samples this share for a human look */
  tierASampleRate: 0.05,
  /** fraud score at or above this flags the placement for ops */
  fraudFlagThreshold: 0.6,
  /** perceptual-hash similarity required for "published media matches approved media" */
  mediaMatchThreshold: 0.9,
  /** strikes that trigger suspension */
  seriousStrikesToSuspend: 1,
  minorStrikesToSuspend: 3,
  suspensionDays: 90,
  /** campaign auto-reopens once if this share of reservations releases */
  reopenReleaseRatio: 0.2,
  reopenWindowMs: 24 * 60 * 60 * 1000,
} as const

/** Default go-live: Friday 18:00 Europe/Stockholm — docs/02 B1 step 1. */
export const DROP_SCHEDULE = { weekday: 5, hour: 18, minute: 0, timeZone: 'Europe/Stockholm' } as const

export type RateCard = {
  cpmOre: number
  fixedOre: number
  viewFloor: number
  takeRateBps: number
}

/** The rate card the landing-page estimator uses before any campaign exists. */
export const ESTIMATOR_RANGE: { low: RateCard; high: RateCard } = {
  low: {
    cpmOre: FLOORS.cpmOre,
    fixedOre: FLOORS.fixedOre,
    viewFloor: DEFAULTS.viewFloor,
    takeRateBps: DEFAULTS.takeRateBps,
  },
  high: {
    cpmOre: DEFAULTS.cpmOre,
    fixedOre: DEFAULTS.fixedOre,
    viewFloor: DEFAULTS.viewFloor,
    takeRateBps: DEFAULTS.takeRateBps,
  },
}

/** The three example rows on the landing page. Recomputed, never hardcoded. */
export const ESTIMATOR_EXAMPLE_VIEWS = [400, 1_500, 5_000] as const
