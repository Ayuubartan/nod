/**
 * Feature flags and ops-editable pricing floors — docs/08 "Feature flags via a `flags`
 * table, not env vars, so ops can toggle Tier A/B review, floors, etc."
 *
 * Every value has a compile-time default from lib/money/rates.ts. The DB row only ever
 * overrides it, so a missing or malformed flag can never take the product down.
 */

import { prisma } from './db'
import { DEFAULTS, FLOORS, LIMITS } from './money/rates'

export const FLAG_DEFAULTS = {
  // pricing floors — the campaign builder validates against these
  'pricing.floor.cpmOre': FLOORS.cpmOre,
  'pricing.floor.fixedOre': FLOORS.fixedOre,
  'pricing.floor.viewFloor': FLOORS.viewFloor,
  'pricing.floor.perPersonCap': FLOORS.perPersonCap,
  'pricing.default.cpmOre': DEFAULTS.cpmOre,
  'pricing.default.fixedOre': DEFAULTS.fixedOre,
  'pricing.default.takeRateBps': DEFAULTS.takeRateBps,
  'pricing.default.perPlacementMaxOre': DEFAULTS.perPlacementMaxOre,
  'pricing.default.creditTermsFeeBps': DEFAULTS.creditTermsFeeBps,
  'pricing.payoutThresholdOre': DEFAULTS.payoutThresholdOre,

  // account eligibility floor — docs/03 SocialAccount sub-states
  'eligibility.minFollowers': FLOORS.minFollowers,
  'eligibility.minAvgViews': FLOORS.minAvgViews,

  // review
  'review.tierASampleRate': LIMITS.tierASampleRate,
  'review.firstCampaignForcesTierB': true,

  // fraud
  'fraud.flagThreshold': LIMITS.fraudFlagThreshold,
  'fraud.mediaMatchThreshold': LIMITS.mediaMatchThreshold,

  // referral
  'referral.enabled': true,
  'referral.bonusOre': DEFAULTS.referralBonusOre,

  // drop schedule — Friday 18:00 Europe/Stockholm
  'drop.weekday': 5,
  'drop.hour': 18,

  // funding
  'funding.invoiceEnabled': false,
  'funding.allowFundBeforeCashForWhitelisted': false,

  // notifications
  'notify.smsFallbackEnabled': false,
  'notify.slackEnabled': true,

  // brand safety — prohibited regardless of what the brand asks for (docs/07 section 6)
  'safety.prohibitedCategories': [
    'gambling',
    'political',
    'tobacco',
    'alcohol-under-25',
    'age-gated',
  ] as string[],
} as const

export type FlagKey = keyof typeof FLAG_DEFAULTS

type FlagValue<K extends FlagKey> = (typeof FLAG_DEFAULTS)[K]

let cache: Map<string, unknown> | null = null
let cachedAt = 0
const CACHE_MS = 15_000

async function load(): Promise<Map<string, unknown>> {
  const now = Date.now()
  if (cache && now - cachedAt < CACHE_MS) return cache
  const rows = await prisma.flag.findMany()
  cache = new Map(rows.map((r) => [r.key, r.value]))
  cachedAt = now
  return cache
}

export function invalidateFlagCache(): void {
  cache = null
  cachedAt = 0
}

/** Read one flag. Falls back to the compile-time default on any miss or type mismatch. */
export async function flag<K extends FlagKey>(key: K): Promise<FlagValue<K>> {
  const fallback = FLAG_DEFAULTS[key]
  try {
    const flags = await load()
    if (!flags.has(key)) return fallback
    const value = flags.get(key)
    if (value === null || value === undefined) return fallback
    if (typeof value !== typeof fallback && !Array.isArray(fallback)) return fallback
    return value as FlagValue<K>
  } catch {
    return fallback
  }
}

/** Read several flags at once — one DB round trip for a whole screen. */
export async function flags<K extends FlagKey>(...keys: K[]): Promise<{ [P in K]: FlagValue<P> }> {
  const out = {} as { [P in K]: FlagValue<P> }
  for (const key of keys) out[key] = (await flag(key)) as FlagValue<K> as never
  return out
}

export async function setFlag<K extends FlagKey>(key: K, value: FlagValue<K>): Promise<void> {
  await prisma.flag.upsert({
    where: { key },
    create: { key, value: value as never },
    update: { value: value as never },
  })
  invalidateFlagCache()
}

/** Seeds any flag that has no row yet. Idempotent — safe on every deploy. */
export async function seedFlags(): Promise<number> {
  const existing = new Set((await prisma.flag.findMany({ select: { key: true } })).map((r) => r.key))
  const missing = (Object.keys(FLAG_DEFAULTS) as FlagKey[]).filter((k) => !existing.has(k))
  if (missing.length > 0) {
    await prisma.flag.createMany({
      data: missing.map((key) => ({ key, value: FLAG_DEFAULTS[key] as never })),
    })
    invalidateFlagCache()
  }
  return missing.length
}
