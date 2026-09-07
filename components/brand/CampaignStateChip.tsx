import { getTranslations } from 'next-intl/server'
import type { CampaignState } from '@prisma/client'

/** Same colour language as the placement chip: green = money moving, amber = waiting on the brand. */
const TONE: Record<CampaignState, string> = {
  DRAFT: 'neutral',
  SUBMITTED: 'neutral',
  RETURNED: 'amber',
  AWAITING_FUNDS: 'amber',
  FUNDED: 'blue',
  LIVE: 'green',
  FILLING: 'green',
  EXHAUSTED: 'blue',
  EXPIRED: 'red',
  PAUSED: 'amber',
  RECONCILING: 'blue',
  CLOSED: 'neutral',
}

const CLASSES: Record<string, string> = {
  amber: 'bg-[var(--color-amber)] text-[#14110F]',
  green: 'bg-[var(--color-green)] text-white',
  blue: 'bg-[var(--color-blue)] text-white',
  red: 'bg-[var(--color-red)] text-white',
  neutral: 'bg-[var(--color-line)] text-[var(--color-ink-2)]',
}

export async function CampaignStateChip({ state }: { state: CampaignState }) {
  const t = await getTranslations('brandApp.campaignStates')
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${CLASSES[TONE[state]]}`}>
      {t(state)}
    </span>
  )
}
