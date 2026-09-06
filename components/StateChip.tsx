import { getTranslations } from 'next-intl/server'
import type { PlacementState } from '@prisma/client'

/** Colour follows meaning: green paid, red terminal-bad, amber waiting on you. */
const TONE: Record<PlacementState, string> = {
  CLAIMED: 'amber',
  UPLOADED: 'amber',
  POSITIONED: 'amber',
  GENERATING: 'neutral',
  GENERATION_FAILED: 'red',
  PARTICIPANT_REVIEW: 'amber',
  BRAND_REVIEW: 'neutral',
  APPROVED: 'amber',
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

const CLASSES: Record<string, string> = {
  amber: 'bg-[var(--color-amber)] text-[#14110F]',
  green: 'bg-[var(--color-green)] text-white',
  red: 'bg-[var(--color-red)] text-white',
  neutral: 'bg-[var(--color-line)] text-[var(--color-ink-2)]',
}

export async function StateChip({ state }: { state: PlacementState }) {
  const t = await getTranslations('placement.states')
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${CLASSES[TONE[state]]}`}>
      {t(state)}
    </span>
  )
}
