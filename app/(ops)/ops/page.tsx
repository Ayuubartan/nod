import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { nodRevenueOre } from '@/lib/money/balances'
import { payableWallets } from '@/lib/state/money'
import { formatOre } from '@/lib/money/calc'

/** Ops home — the queues that have an SLA, and today's numbers. */
export const dynamic = 'force-dynamic'

export default async function OpsHomePage() {
  await requireOps()

  const [submitted, generating, verifying, flagged, disputes, payable, revenue] = await Promise.all([
    prisma.campaign.count({ where: { state: 'SUBMITTED', deletedAt: null } }),
    prisma.placement.count({ where: { state: { in: ['GENERATING', 'GENERATION_FAILED'] }, deletedAt: null } }),
    prisma.placement.count({ where: { state: 'VERIFYING', deletedAt: null } }),
    prisma.placement.count({ where: { state: 'FLAGGED', deletedAt: null } }),
    prisma.dispute.count({ where: { state: 'OPEN' } }),
    payableWallets(),
    nodRevenueOre(prisma),
  ])

  const queues = [
    { label: 'Campaigns to review', value: submitted, href: '/ops/campaigns' },
    { label: 'Generation queue', value: generating, href: '/ops/generation' },
    { label: 'Awaiting view entry', value: verifying, href: '/ops/verification' },
    { label: 'Fraud flags', value: flagged, href: '/ops/verification' },
    { label: 'Open disputes', value: disputes, href: '/ops/verification' },
    { label: 'Wallets to pay', value: payable.length, href: '/ops/payouts' },
  ]

  return (
    <div>
      <h1 className="text-xl mb-4">Today</h1>

      <ul className="grid gap-3 sm:grid-cols-3 mb-8">
        {queues.map((queue) => (
          <li key={queue.label}>
            <Link href={queue.href} className="card p-4 block">
              <p className="text-xs text-[var(--color-ink-2)] mb-1">{queue.label}</p>
              <p
                className="amount text-3xl font-bold"
                style={{ color: queue.value > 0 ? 'var(--color-amber-dk)' : 'var(--color-ink-3)' }}
              >
                {queue.value}
              </p>
            </Link>
          </li>
        ))}
      </ul>

      <div className="card p-4">
        <p className="text-xs text-[var(--color-ink-2)] mb-1">NOD revenue to date</p>
        <p className="amount text-2xl font-bold">{formatOre(revenue)}</p>
      </div>
    </div>
  )
}
