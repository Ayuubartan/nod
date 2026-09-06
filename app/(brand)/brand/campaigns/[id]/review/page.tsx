import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireBrandUser } from '@/lib/auth'
import { Countdown } from '@/components/Countdown'
import { BrandReviewCard } from '@/components/brand/BrandReviewCard'

/** Tier B review queue — docs/02 B2. Anything unreviewed auto-approves at 24h. */
export const dynamic = 'force-dynamic'

export default async function BrandReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('brandApp')

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { id: true, brandId: true, name: true },
  })
  if (!campaign) notFound()

  await requireBrandUser(campaign.brandId)

  const queue = await prisma.placement.findMany({
    where: { campaignId: id, state: 'BRAND_REVIEW', deletedAt: null },
    include: {
      account: { select: { handle: true } },
      versions: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { deadlineAt: 'asc' },
  })

  return (
    <div>
      <h1 className="text-2xl mb-1">{t('reviewQueue')}</h1>
      <p className="text-sm text-[var(--color-ink-2)] mb-6">{campaign.name}</p>

      {queue.length === 0 ? (
        <p className="card p-8 text-center text-sm text-[var(--color-ink-3)]">—</p>
      ) : (
        <>
          <p className="text-xs text-[var(--color-ink-3)] mb-4">
            <Countdown to={queue[0]!.deadlineAt.toISOString()} />
          </p>
          <ul className="grid gap-4 sm:grid-cols-2">
            {queue.map((placement) => (
              <li key={placement.id}>
                <BrandReviewCard
                  placementId={placement.id}
                  handle={placement.account.handle}
                  versionPath={placement.versions[0]?.storagePath ?? null}
                  deadline={placement.deadlineAt.toISOString()}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
