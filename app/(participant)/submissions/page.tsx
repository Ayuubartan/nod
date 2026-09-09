import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { requireParticipant } from '@/lib/auth'
import { payoutBySubmission } from '@/lib/clips/payouts'
import { ClipSubmissionRow } from '@/components/participant/ClipSubmissionRow'

/** My clips — docs/14 §1. The clip counterpart of /placements. */
export const dynamic = 'force-dynamic'

const FILTERS = ['active', 'paid', 'rejected'] as const
type Filter = (typeof FILTERS)[number]

export default async function SubmissionsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const user = await requireParticipant()
  const t = await getTranslations('clips.list')
  const { filter } = await searchParams
  const active: Filter = (FILTERS as readonly string[]).includes(filter ?? '') ? (filter as Filter) : 'active'

  const stateFilter: Prisma.EnumSubmissionStateFilter =
    active === 'paid'
      ? { in: ['QUALIFIED', 'PAID'] }
      : active === 'rejected'
        ? { equals: 'REJECTED' }
        : { in: ['RECEIVED', 'FIX_DISCLOSURE', 'TRACKING', 'VALIDATING', 'HELD'] }

  const submissions = await prisma.submission.findMany({
    where: { userId: user.id, deletedAt: null, state: stateFilter },
    include: { campaign: { select: { name: true, brand: { select: { name: true } } } } },
    orderBy: { submittedAt: 'desc' },
    take: 100,
  })
  const payouts = await payoutBySubmission(submissions.map((s) => s.id))

  return (
    <div>
      <h1 className="text-2xl mb-4">{t('title')}</h1>

      <nav className="flex gap-2 mb-4" aria-label="Clip filters">
        {FILTERS.map((name) => (
          <Link key={name} href={`/submissions?filter=${name}`} className="chip" aria-pressed={active === name}>
            {t(`filters.${name}`)}
          </Link>
        ))}
      </nav>

      {submissions.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-sm text-[var(--color-ink-2)] mb-3">{t('empty')}</p>
          <Link href="/campaigns" className="btn btn-secondary text-sm">
            {t('browse')}
          </Link>
        </div>
      ) : (
        <ul className="grid gap-2">
          {submissions.map((row) => (
            <ClipSubmissionRow key={row.id} row={row} payoutOre={payouts.get(row.id)} />
          ))}
        </ul>
      )}
    </div>
  )
}
