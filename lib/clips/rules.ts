/**
 * Pure rules for clip campaigns — docs/14 §3-5. No I/O, fully unit-tested.
 */

import type { FraudAssessment } from '@/lib/fraud'
import { disclosurePresent } from '@/lib/media'

// ---------------------------------------------------------------- caption rules

/** Markers accepted anywhere in the caption when the issued phrase is missing (docs/14 D6). */
const DISCLOSURE_TAGS = ['#reklam', '#ad', '#annons', '#samarbete', '#sponsrad', '#sponsored']

export type CaptionRules = {
  disclosureText: string
  requiredHashtags: string[]
  requiredMentions: string[]
}

export type CaptionCheck = {
  disclosureOk: boolean
  missingHashtags: string[]
  missingMentions: string[]
  ok: boolean
}

const normaliseTag = (tag: string) => tag.trim().toLowerCase().replace(/^#/, '')
const normaliseMention = (m: string) => m.trim().toLowerCase().replace(/^@/, '')

/**
 * Disclosure is a payable condition (CLAUDE.md rule 5). The placement rule accepts the
 * issued phrase or a marker on the first line; clips also accept the platform-native
 * paid-partnership label and a disclosure hashtag anywhere, because that is how creators
 * actually mark ads on TikTok and Instagram.
 */
export function checkCaption(
  caption: string | null | undefined,
  rules: CaptionRules,
  paidPartnershipLabel = false,
): CaptionCheck {
  const text = (caption ?? '').toLowerCase()
  const tags = new Set(Array.from(text.matchAll(/#([\p{L}\p{N}_]+)/gu), (m) => m[1]!.toLowerCase()))
  const mentions = new Set(Array.from(text.matchAll(/@([\p{L}\p{N}_.]+)/gu), (m) => m[1]!.toLowerCase().replace(/\.$/, '')))

  const disclosureOk =
    paidPartnershipLabel ||
    disclosurePresent(caption, rules.disclosureText) ||
    DISCLOSURE_TAGS.some((t) => tags.has(t.slice(1)))

  const missingHashtags = rules.requiredHashtags.map(normaliseTag).filter((t) => t && !tags.has(t))
  const missingMentions = rules.requiredMentions.map(normaliseMention).filter((m) => m && !mentions.has(m))

  return {
    disclosureOk,
    missingHashtags,
    missingMentions,
    ok: disclosureOk && missingHashtags.length === 0 && missingMentions.length === 0,
  }
}

// ---------------------------------------------------------------- publish window

/** Posts up to 24 h before go-live count: creators often post the night before a launch. */
export const PUBLISH_GRACE_BEFORE_MS = 24 * 60 * 60 * 1000

export function insidePublishWindow(
  publishedAt: Date,
  campaign: { liveAt: Date | null; startsAt: Date | null; endsAt: Date | null },
): boolean {
  const start = campaign.liveAt ?? campaign.startsAt
  if (start && publishedAt.getTime() < start.getTime() - PUBLISH_GRACE_BEFORE_MS) return false
  if (campaign.endsAt && publishedAt.getTime() > campaign.endsAt.getTime()) return false
  return true
}

// ---------------------------------------------------------------- cadence

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** docs/14 §4 table: how long until the next metrics check, by post age. */
export const CADENCE: ReadonlyArray<{ maxAgeMs: number; delayMs: number; priority: number }> = [
  { maxAgeMs: 6 * HOUR, delayMs: 10 * MIN, priority: 0 },
  { maxAgeMs: 24 * HOUR, delayMs: 30 * MIN, priority: 1 },
  { maxAgeMs: 3 * DAY, delayMs: 60 * MIN, priority: 2 },
  { maxAgeMs: 14 * DAY, delayMs: 4 * HOUR, priority: 3 },
  { maxAgeMs: Number.POSITIVE_INFINITY, delayMs: 24 * HOUR, priority: 4 },
]

export const MAX_CHECK_DELAY_MS = 24 * HOUR
/** Two consecutive misses → DELETED_EARLY (docs/14 §4). */
export const MISSING_CHECKS_TO_REJECT = 2
/** A dead token parks the account's submissions this long before the next attempt. */
export const TOKEN_PAUSE_MS = 6 * HOUR
/** The 5-minute bucket every snapshot is keyed by. */
export const SNAPSHOT_BUCKET_MS = 5 * MIN

export function cadenceFor(postAgeMs: number): { delayMs: number; priority: number } {
  const row = CADENCE.find((r) => postAgeMs < r.maxAgeMs) ?? CADENCE[CADENCE.length - 1]!
  return { delayMs: row.delayMs, priority: row.priority }
}

/**
 * Next check time. Failures back off (×2 from the third consecutive failure, capped at a
 * day) and the check never lands after the validation end — the final pull is that one.
 */
export function nextCheckAt(
  now: Date,
  publishedAt: Date,
  consecutiveFailures: number,
  validationEndsAt: Date | null,
): { at: Date; priority: number } {
  const { delayMs, priority } = cadenceFor(now.getTime() - publishedAt.getTime())
  const backoff = consecutiveFailures >= 3 ? Math.min(MAX_CHECK_DELAY_MS, delayMs * 2 ** (consecutiveFailures - 2)) : delayMs
  let at = new Date(now.getTime() + backoff)
  if (validationEndsAt && at > validationEndsAt && validationEndsAt > now) at = validationEndsAt
  return { at, priority }
}

export function bucketOf(observedAt: Date): number {
  return Math.floor(observedAt.getTime() / SNAPSHOT_BUCKET_MS)
}

// ---------------------------------------------------------------- reservation & estimate

/** docs/14 D2: reserve the per-post cap, or whatever is left, or nothing. */
export function submissionReservationOre(perPostCapOre: number, availableOre: number): number {
  return Math.max(0, Math.min(perPostCapOre, availableOre))
}

// ---------------------------------------------------------------- risk

export type SnapshotPoint = { observedAt: Date; views: number }

export type ClipRiskFactor = { name: string; score: number; detail: string }

/**
 * Series-level signals the account-baseline score cannot see (docs/14 §5 step 2):
 *  - one interval carrying more than half of all views on a post with real volume
 *  - a run of identical increments (bot delivery in fixed batches)
 *  - views going down (platform removed fake views, or the count was reset)
 */
export function clipRiskFactors(points: SnapshotPoint[]): ClipRiskFactor[] {
  const factors: ClipRiskFactor[] = []
  if (points.length < 3) return factors

  const sorted = [...points].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())
  const total = sorted[sorted.length - 1]!.views - sorted[0]!.views
  const deltas = sorted.slice(1).map((p, i) => p.views - sorted[i]!.views)

  const maxJump = Math.max(...deltas)
  if (total > 5000 && maxJump > total * 0.5) {
    factors.push({ name: 'single_interval_spike', score: 0.8, detail: `${maxJump} of ${total} views arrived in one interval` })
  }

  const positive = deltas.filter((d) => d > 0)
  if (positive.length >= 4) {
    const runs = positive.slice(1).filter((d, i) => d === positive[i]).length
    if (runs >= Math.floor(positive.length * 0.6)) {
      factors.push({ name: 'flat_increments', score: 0.7, detail: `${runs + 1} identical increments of ${positive[0]}` })
    }
  }

  const drop = Math.min(...deltas)
  if (drop < 0 && Math.abs(drop) > Math.max(50, sorted[sorted.length - 1]!.views * 0.02)) {
    factors.push({ name: 'views_decreased', score: 0.4, detail: `views fell by ${Math.abs(drop)}` })
  }

  return factors
}

export type RiskDisposition = 'ALLOW' | 'ALLOW_WITH_MONITORING' | 'HOLD_FOR_REVIEW' | 'REJECT_SUBMISSION'

/**
 * Combine the baseline assessment (0..1) with the series factors into the spec's 0-100
 * band. The series factors can raise but never lower the score.
 */
export function riskBand(
  baseline: Pick<FraudAssessment, 'score'>,
  series: ClipRiskFactor[],
): { score: number; disposition: RiskDisposition } {
  const seriesMax = series.reduce((m, f) => Math.max(m, f.score), 0)
  const combined = Math.min(1, baseline.score + seriesMax * 0.5)
  const score = Math.round(combined * 100)
  const disposition: RiskDisposition =
    score >= 80 ? 'REJECT_SUBMISSION' : score >= 60 ? 'HOLD_FOR_REVIEW' : score >= 30 ? 'ALLOW_WITH_MONITORING' : 'ALLOW'
  return { score, disposition }
}
