import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireParticipant } from '@/lib/auth'
import { StateChip } from '@/components/StateChip'
import { Countdown } from '@/components/Countdown'
import { TERMINAL_STATES } from '@/lib/state/placement'

/** My placements — docs/02 A4. */
export const dynamic = 'force-dynamic'

const FILTERS = { active: 'active', paid: 'paid', rejected: 'rejected' } as const

export default async function PlacementsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const user = await requireParticipant()
  const t = await getTranslations('placements')
  const { filter } = await searchParams
  const active = (filter as keyof typeof FILTERS) ?? 'active'

  const stateFilter: Prisma.EnumPlacementStateFilter =
    active === 'paid'
      ? { in: ['QUALIFIED', 'PAID'] }
      : active === 'rejected'
        ? { in: ['REJECTED', 'EXPIRED', 'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND'] }
        : { notIn: TERMINAL_STATES }

  const placements = await prisma.placement.findMany({
    where: { userId: user.id, deletedAt: null, state: stateFilter },
    include: { campaign: { select: { name: true, brand: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return (
    <div>
      <h1 className="text-2xl mb-4">{t('title')}</h1>

      <nav className="flex gap-2 mb-4" aria-label="Placement filters">
        {(Object.keys(FILTERS) as Array<keyof typeof FILTERS>).map((name) => (
          <Link key={name} href={`/placements?filter=${name}`} className="chip" aria-pressed={active === name}>
            {t(`filters.${name}`)}
          </Link>
        ))}
      </nav>

      {placements.length === 0 ? (
        <p className="card p-6 text-center text-sm text-[var(--color-ink-2)]">{t('empty')}</p>
      ) : (
        <ul className="grid gap-2">
          {placements.map((placement) => (
            <li key={placement.id}>
              <Link href={`/placements/${placement.id}`} className="card p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{placement.campaign.brand.name}</p>
                  <p className="text-sm text-[var(--color-ink-2)] truncate">{placement.campaign.name}</p>
                  {!TERMINAL_STATES.includes(placement.state) && !placement.clockPausedAt && (
                    <Countdown
                      to={placement.deadlineAt.toISOString()}
                      className="text-xs text-[var(--color-ink-3)]"
                    />
                  )}
                </div>
                <StateChip state={placement.state} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
