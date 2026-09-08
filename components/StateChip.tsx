import { getTranslations } from 'next-intl/server'
import type { PlacementState } from '@prisma/client'

/** Who is looking at the chip. "Waiting for you" means someone different on each side. */
export type Perspective = 'participant' | 'brand'

/** Colour follows meaning: green paid, red terminal-bad, amber waiting on you. */
const TONE: Record<PlacementState, string> = {
  CLAIMED: 'orange',
  UPLOADED: 'orange',
  POSITIONED: 'orange',
  GENERATING: 'neutral',
  GENERATION_FAILED: 'red',
  PARTICIPANT_REVIEW: 'orange',
  BRAND_REVIEW: 'neutral',
  APPROVED: 'orange',
  PUBLISHED: 'neutral',
  VERIFYING: 'neutral',
  FLAGGED: 'neutral',
  QUALIFIED: 'green',
  PAID: 'green',
  REJECTED: 'red',
  EXPIRED: 'red',
  REJECTED_BY_PARTICIPANT: 'red',
  REJECTED_BY_BRAND: 'red',
  DISPUTED: 'red',
}

/**
 * Seen from the brand, the steps the participant owns are just "in progress", and the
 * one step the brand owns is the one that wants attention. Everything else reads the
 * same from both sides.
 */
const BRAND_OVERRIDES: Partial<Record<PlacementState, { tone: string }>> = {
  CLAIMED: { tone: 'neutral' },
  UPLOADED: { tone: 'neutral' },
  POSITIONED: { tone: 'neutral' },
  PARTICIPANT_REVIEW: { tone: 'neutral' },
  BRAND_REVIEW: { tone: 'orange' },
  APPROVED: { tone: 'neutral' },
}

/** States whose wording depends on who is reading; keys live under `placement.brandStates`. */
const BRAND_LABELS = new Set<PlacementState>([
  'PARTICIPANT_REVIEW',
  'BRAND_REVIEW',
  'APPROVED',
  'REJECTED_BY_PARTICIPANT',
  'REJECTED_BY_BRAND',
])

const CLASSES: Record<string, string> = {
  orange: 'bg-[var(--color-orange)] text-[#111820]',
  green: 'bg-[var(--color-green)] text-white',
  red: 'bg-[var(--color-red)] text-white',
  neutral: 'bg-[var(--color-line)] text-[var(--color-ink-2)]',
}

export async function StateChip({
  state,
  perspective = 'participant',
}: {
  state: PlacementState
  perspective?: Perspective
}) {
  const t = await getTranslations('placement')
  const brand = perspective === 'brand'
  const tone = (brand && BRAND_OVERRIDES[state]?.tone) || TONE[state]
  const label = brand && BRAND_LABELS.has(state) ? t(`brandStates.${state}`) : t(`states.${state}`)
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${CLASSES[tone]}`}>
      {label}
    </span>
  )
}
