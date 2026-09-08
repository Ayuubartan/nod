import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { PlacementState } from '@prisma/client'

/**
 * Placement funnel — where every claim sits right now. Nine buckets is what a brand can
 * hold in their head; the eighteen raw states are for ops.
 */
export type FunnelStage =
  | 'claimed'
  | 'making'
  | 'participantReview'
  | 'brandReview'
  | 'approved'
  | 'published'
  | 'verified'
  | 'paid'
  | 'ended'

export const STAGE_OF: Record<PlacementState, FunnelStage> = {
  CLAIMED: 'claimed',
  UPLOADED: 'making',
  POSITIONED: 'making',
  GENERATING: 'making',
  GENERATION_FAILED: 'making',
  PARTICIPANT_REVIEW: 'participantReview',
  BRAND_REVIEW: 'brandReview',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  VERIFYING: 'published',
  FLAGGED: 'published',
  QUALIFIED: 'verified',
  PAID: 'paid',
  REJECTED: 'ended',
  EXPIRED: 'ended',
  REJECTED_BY_PARTICIPANT: 'ended',
  REJECTED_BY_BRAND: 'ended',
  DISPUTED: 'ended',
}

const ORDER: FunnelStage[] = [
  'claimed',
  'making',
  'participantReview',
  'brandReview',
  'approved',
  'published',
  'verified',
  'paid',
  'ended',
]

const TONE: Record<FunnelStage, string> = {
  claimed: 'var(--color-ink-3)',
  making: 'var(--color-ink-3)',
  participantReview: 'var(--color-orange)',
  brandReview: 'var(--color-orange)',
  approved: 'var(--color-blue)',
  published: 'var(--color-blue)',
  verified: 'var(--color-green)',
  paid: 'var(--color-green)',
  ended: 'var(--color-red)',
}

export function countStages(states: PlacementState[]): Record<FunnelStage, number> {
  const out = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<FunnelStage, number>
  for (const state of states) out[STAGE_OF[state]] += 1
  return out
}

export async function Funnel({ states, reviewHref }: { states: PlacementState[]; reviewHref: string }) {
  const t = await getTranslations('brandApp.funnel')
  const counts = countStages(states)
  const max = Math.max(1, ...ORDER.map((s) => counts[s]))

  if (states.length === 0) {
    return <p className="card p-6 text-sm text-[var(--color-ink-3)]">{t('none')}</p>
  }

  return (
    <ol className="card p-4 grid gap-2">
      {ORDER.map((stage) => {
        const n = counts[stage]
        const label =
          stage === 'brandReview' && n > 0 ? (
            <Link href={reviewHref} className="underline decoration-[var(--color-orange)] underline-offset-2">
              {t(stage)}
            </Link>
          ) : (
            t(stage)
          )
        return (
          <li key={stage} className="flex items-center gap-3">
            <span className="text-sm w-40 shrink-0 truncate">{label}</span>
            <span className="flex-1 h-5 rounded bg-[var(--color-bg)] overflow-hidden">
              <span
                className="block h-full rounded"
                style={{ width: `${(n / max) * 100}%`, background: TONE[stage], minWidth: n ? 6 : 0 }}
              />
            </span>
            <span className="tabular text-sm font-semibold w-8 text-right">{n}</span>
          </li>
        )
      })}
    </ol>
  )
}
