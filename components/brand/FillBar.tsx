import type { CampaignBalance } from '@/lib/money/balances'

/**
 * One bar for the whole budget: spent (solid) + reserved (hatched) out of budget. The
 * brand reads "how much of my money is committed" at a glance, which the three numbers
 * alone never quite gave them.
 */
export function FillBar({ balance, className = '' }: { balance: CampaignBalance; className?: string }) {
  const budget = Math.max(balance.budgetOre, 1)
  const spent = Math.min(100, (balance.spentOre / budget) * 100)
  const reserved = Math.min(100 - spent, (balance.reservedOre / budget) * 100)

  return (
    <div
      className={`h-2 w-full rounded-full bg-[var(--color-line)] overflow-hidden flex ${className}`}
      role="img"
      aria-label={`${Math.round(spent)}% + ${Math.round(reserved)}%`}
    >
      <span className="h-full block" style={{ width: `${spent}%`, background: 'var(--color-blue)' }} />
      <span
        className="h-full block"
        style={{
          width: `${reserved}%`,
          backgroundImage:
            'repeating-linear-gradient(135deg, var(--color-blue) 0 3px, color-mix(in srgb, var(--color-blue) 35%, transparent) 3px 6px)',
        }}
      />
    </div>
  )
}

/** Percent of budget that is spent or reserved — what "fill" means on the index. */
export function fillPercent(balance: CampaignBalance): number {
  if (balance.budgetOre <= 0) return 0
  return Math.min(100, Math.round(((balance.spentOre + balance.reservedOre) / balance.budgetOre) * 100))
}
