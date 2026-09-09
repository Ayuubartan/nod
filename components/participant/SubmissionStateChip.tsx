import { getTranslations } from 'next-intl/server'
import type { SubmissionState } from '@prisma/client'

/** Same colour language as StateChip: green paid, red terminal-bad, amber waiting on you. */
const TONE: Record<SubmissionState, string> = {
  RECEIVED: 'neutral',
  FIX_DISCLOSURE: 'orange',
  TRACKING: 'neutral',
  VALIDATING: 'neutral',
  HELD: 'neutral',
  QUALIFIED: 'green',
  PAID: 'green',
  REJECTED: 'red',
}

const CLASSES: Record<string, string> = {
  orange: 'bg-[var(--color-orange)] text-[#111820]',
  green: 'bg-[var(--color-green)] text-white',
  red: 'bg-[var(--color-red)] text-white',
  neutral: 'bg-[var(--color-line)] text-[var(--color-ink-2)]',
}

export async function SubmissionStateChip({ state }: { state: SubmissionState }) {
  const t = await getTranslations('clips.states')
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${CLASSES[TONE[state]]}`}>
      {t(state)}
    </span>
  )
}
