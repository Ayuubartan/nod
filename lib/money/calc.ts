/**
 * Pure money functions — docs/05-pricing.md "Formulas".
 *
 * Everything here is a pure function over integers in öre. No I/O, no Date.now(),
 * no Prisma. Tested to 100% in tests/money/calc.test.ts against every worked example
 * in the pricing doc.
 *
 * Rounding rules (docs/05):
 *   - participant share rounds DOWN to the öre; NOD keeps the remainder
 *   - reservation rounds UP to the nearest krona
 */

import { DEFAULTS, ORE_PER_SEK, RESERVATION_VIEW_MULTIPLIER, sek } from './rates'

export type Template = {
  fixedOre: number
  cpmOre: number
  bonusAtViews?: number | null
  bonusOre?: number | null
  viewFloor: number
  takeRateBps: number
}

export type AccountLike = { avgViews30d: number }

function assertInt(name: string, v: number): void {
  if (!Number.isInteger(v)) throw new Error(`${name} must be an integer number of öre, got ${v}`)
}

function assertNonNegative(name: string, v: number): void {
  assertInt(name, v)
  if (v < 0) throw new Error(`${name} must not be negative, got ${v}`)
}

/** What the participant receives from an all-in amount. Rounds down. */
export function participantShare(oreAllIn: number, takeRateBps: number = DEFAULTS.takeRateBps): number {
  assertNonNegative('oreAllIn', oreAllIn)
  if (!Number.isInteger(takeRateBps) || takeRateBps < 0 || takeRateBps > 10_000) {
    throw new Error(`takeRateBps must be an integer 0..10000, got ${takeRateBps}`)
  }
  return Math.floor((oreAllIn * (10_000 - takeRateBps)) / 10_000)
}

/** NOD's spread. Always the remainder, so share + take === allIn exactly. */
export function nodTake(oreAllIn: number, takeRateBps: number = DEFAULTS.takeRateBps): number {
  return oreAllIn - participantShare(oreAllIn, takeRateBps)
}

/** Round an öre amount up to the nearest whole krona. */
export function roundUpToKrona(ore: number): number {
  assertNonNegative('ore', ore)
  return Math.ceil(ore / ORE_PER_SEK) * ORE_PER_SEK
}

/**
 * What a claim locks out of the campaign's available budget.
 *
 *   reservation = fixed + cpm x ceil(2 x avgViews / 1000) + bonus, capped by perPlacementMax
 *
 * The 2x multiplier means a normal over-performance never exceeds the reservation, so
 * the participant is never short-paid because the budget was under-reserved.
 */
export function reservationOre(
  template: Template,
  account: AccountLike,
  perPlacementMaxOre: number = DEFAULTS.perPlacementMaxOre,
): number {
  assertNonNegative('template.fixedOre', template.fixedOre)
  assertNonNegative('template.cpmOre', template.cpmOre)
  assertNonNegative('perPlacementMaxOre', perPlacementMaxOre)
  if (account.avgViews30d < 0) throw new Error('account.avgViews30d must not be negative')

  const thousands = Math.ceil((RESERVATION_VIEW_MULTIPLIER * account.avgViews30d) / 1000)
  const raw = template.fixedOre + template.cpmOre * thousands + (template.bonusOre ?? 0)
  return Math.min(roundUpToKrona(raw), perPlacementMaxOre)
}

/**
 * What the brand owes, all-in, for a placement that qualified with this many views.
 * Below the view floor only the fixed component is paid — never a 1k minimum (docs/05).
 */
export function payoutAllInOre(template: Template, qualifiedViews: number): number {
  assertNonNegative('template.fixedOre', template.fixedOre)
  assertNonNegative('template.cpmOre', template.cpmOre)
  if (qualifiedViews < 0) throw new Error('qualifiedViews must not be negative')

  if (qualifiedViews < template.viewFloor) return template.fixedOre

  const bonus =
    template.bonusAtViews != null && template.bonusOre != null && qualifiedViews >= template.bonusAtViews
      ? template.bonusOre
      : 0

  return template.fixedOre + Math.floor((template.cpmOre * qualifiedViews) / 1000) + bonus
}

export type Settlement = {
  /** all-in owed by the brand, capped at the reservation */
  allInOre: number
  /** participant's net, rounded down */
  toUserOre: number
  /** NOD's spread, the remainder */
  toNodOre: number
  /** unspent reservation returned to campaign.available */
  releaseOre: number
  /** views above what the reservation could pay for — reported to the brand as free reach */
  freeReachViews: number
}

/**
 * Split one qualified placement into the four ledger amounts.
 * Payout NEVER exceeds the reservation; the remainder is released (docs/03 section 4).
 */
export function settle(
  template: Template,
  qualifiedViews: number,
  reservationOreValue: number,
): Settlement {
  assertNonNegative('reservationOre', reservationOreValue)

  const uncapped = payoutAllInOre(template, qualifiedViews)
  const allInOre = Math.min(uncapped, reservationOreValue)
  const toUserOre = participantShare(allInOre, template.takeRateBps)
  const toNodOre = allInOre - toUserOre
  const releaseOre = reservationOreValue - allInOre

  // Views the brand got but did not pay for, because the reservation capped the payout.
  let freeReachViews = 0
  if (uncapped > allInOre && template.cpmOre > 0) {
    const paidForViews = viewsCoveredBy(template, allInOre)
    freeReachViews = Math.max(0, qualifiedViews - paidForViews)
  }

  return { allInOre, toUserOre, toNodOre, releaseOre, freeReachViews }
}

/** Inverse of payoutAllInOre: how many views an all-in amount actually covers. */
function viewsCoveredBy(template: Template, allInOre: number): number {
  const variable = allInOre - template.fixedOre
  if (variable <= 0 || template.cpmOre <= 0) return 0
  return Math.floor((variable * 1000) / template.cpmOre)
}

/** qualified_views = views x geo_match_factor x (1 - fraud_discount) — docs/03 check 6. */
export function qualifiedViews(views: number, geoFactor = 1, fraudDiscount = 0): number {
  if (views < 0) throw new Error('views must not be negative')
  if (geoFactor < 0 || geoFactor > 1) throw new Error('geoFactor must be 0..1')
  if (fraudDiscount < 0 || fraudDiscount > 1) throw new Error('fraudDiscount must be 0..1')
  return Math.floor(views * geoFactor * (1 - fraudDiscount))
}

/** effectiveCpm = spent / (total qualified views / 1000). Returns öre per 1,000 views. */
export function effectiveCpmOre(spentOre: number, totalQualifiedViews: number): number {
  assertNonNegative('spentOre', spentOre)
  if (totalQualifiedViews <= 0) return 0
  return Math.round((spentOre * 1000) / totalQualifiedViews)
}

/** What the participant is told they earn, per 1,000 views and per post. */
export function participantRateCard(template: Template): { fixedOre: number; cpmOre: number } {
  return {
    fixedOre: participantShare(template.fixedOre, template.takeRateBps),
    cpmOre: participantShare(template.cpmOre, template.takeRateBps),
  }
}

/**
 * Landing-page / marketplace estimate: what this participant nets for one placement.
 * Same function the real payout uses, so the estimate can never drift from reality.
 */
export function estimateParticipantOre(template: Template, views: number): number {
  return participantShare(payoutAllInOre(template, views), template.takeRateBps)
}

/** Credit-terms fee on an invoiced campaign budget. */
export function creditTermsFeeOre(budgetOre: number, feeBps: number): number {
  assertNonNegative('budgetOre', budgetOre)
  if (!Number.isInteger(feeBps) || feeBps < 0) throw new Error('feeBps must be a non-negative integer')
  return Math.floor((budgetOre * feeBps) / 10_000)
}

// ------------------------------------------------------------------ formatting

/** "42 kr" — whole kronor, rounded down, for participant-facing copy (docs/05). */
export function formatKrDown(ore: number, locale = 'sv'): string {
  const kr = Math.floor(ore / ORE_PER_SEK)
  return `${new Intl.NumberFormat(locale === 'sv' ? 'sv-SE' : 'en-GB').format(kr)} kr`
}

/** "1 234,50 kr" — exact, for ledgers, dashboards and receipts. */
export function formatOre(ore: number, locale = 'sv'): string {
  const value = ore / ORE_PER_SEK
  return new Intl.NumberFormat(locale === 'sv' ? 'sv-SE' : 'en-GB', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export { sek }
