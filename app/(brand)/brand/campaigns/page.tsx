import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireBrandScope } from '@/lib/auth'
import { campaignBalances } from '@/lib/money/balances'
import { formatOre } from '@/lib/money/calc'
import { CampaignStateChip } from '@/components/brand/CampaignStateChip'
import { FillBar, fillPercent } from '@/components/brand/FillBar'
import { NewCampaignButton } from '@/components/brand/NewCampaignButton'

/** Campaign index — docs/02 section B. */
export const dynamic = 'force-dynamic'

const ACTIVE = new Set(['LIVE', 'FILLING', 'EXHAUSTED', 'PAUSED', 'RECONCILING'])

export default async function BrandCampaignsPage() {
  // Ops browsing the brand surface sees every brand; a brand user sees only their own.
  // Nobody sees anything without a session.
  const { brandId } = await requireBrandScope()
  const t = await getTranslations('brandApp')

  const campaigns = await prisma.campaign.findMany({
    where: { deletedAt: null, ...(brandId ? { brandId } : {}) },
    include: { brand: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const ids = campaigns.map((c) => c.id)
  const [balances, placementRows, reviewRows, qualified] = await Promise.all([
    campaignBalances(prisma, ids),
    prisma.placement.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids }, deletedAt: null }, _count: { _all: true } }),
    prisma.placement.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: ids }, deletedAt: null, state: 'BRAND_REVIEW' },
      _count: { _all: true },
    }),
    prisma.verification.aggregate({ where: { placement: { campaignId: { in: ids } } }, _sum: { qualifiedViews: true } }),
  ])
  const placementCount = new Map(placementRows.map((r) => [r.campaignId, r._count._all]))
  const reviewCount = new Map(reviewRows.map((r) => [r.campaignId, r._count._all]))

  const totals = {
    active: campaigns.filter((c) => ACTIVE.has(c.state)).length,
    budget: [...balances.values()].reduce((sum, b) => sum + b.budgetOre, 0),
    placements: [...placementCount.values()].reduce((sum, n) => sum + n, 0),
    qualifiedViews: qualified._sum.qualifiedViews ?? 0,
  }

  const summary = [
    { label: t('summary.active'), value: totals.active.toLocaleString('sv-SE') },
    { label: t('summary.budget'), value: formatOre(totals.budget) },
    { label: t('summary.placements'), value: totals.placements.toLocaleString('sv-SE') },
    { label: t('summary.qualifiedViews'), value: totals.qualifiedViews.toLocaleString('sv-SE') },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl">{t('campaigns')}</h1>
        {brandId && <NewCampaignButton brandId={brandId} label={t('newCampaign')} />}
      </div>

      {campaigns.length > 0 && (
        <section className="mb-6">
          <h2 className="label">{t('summary.title')}</h2>
          <ul className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {summary.map((item) => (
              <li key={item.label} className="card p-4">
                <p className="text-xs text-[var(--color-ink-2)] mb-1">{item.label}</p>
                <p className="amount text-xl font-semibold">{item.value}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="grid gap-3">
        {campaigns.map((campaign) => {
          const balance = balances.get(campaign.id)
          const review = reviewCount.get(campaign.id) ?? 0
          return (
            <li key={campaign.id}>
              <Link href={`/brand/campaigns/${campaign.id}`} className="card p-4 block hover:border-[var(--color-blue)]">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--color-ink-2)]">{campaign.brand.name}</p>
                    <h2 className="font-semibold truncate">{campaign.name}</h2>
                    <p className="text-xs text-[var(--color-ink-2)] mt-0.5">{t(`nextStep.${campaign.state}`)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {review > 0 && (
                      <span className="chip text-xs bg-[var(--color-amber)] text-[#14110F]">
                        {t('reviewQueue')} · {review}
                      </span>
                    )}
                    <CampaignStateChip state={campaign.state} />
                  </div>
                </div>

                {balance && (
                  <>
                    <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-[var(--color-ink-2)]">{t('budget')}</dt>
                        <dd className="amount font-semibold">{formatOre(balance.budgetOre)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--color-ink-2)]">{t('spent')}</dt>
                        <dd className="amount font-semibold">{formatOre(balance.spentOre)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--color-ink-2)]">{t('reserved')}</dt>
                        <dd className="amount font-semibold">{formatOre(balance.reservedOre)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--color-ink-2)]">{t('available')}</dt>
                        <dd className="amount font-semibold">{formatOre(balance.availableOre)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--color-ink-2)]">{t('placements')}</dt>
                        <dd className="amount font-semibold">{(placementCount.get(campaign.id) ?? 0).toLocaleString('sv-SE')}</dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex items-center gap-3">
                      <FillBar balance={balance} className="flex-1" />
                      <span className="text-xs text-[var(--color-ink-2)] tabular w-24 text-right">
                        {t('fill')} {fillPercent(balance)}%
                      </span>
                    </div>
                  </>
                )}
              </Link>
            </li>
          )
        })}
        {campaigns.length === 0 && (
          <li className="card p-8 text-center text-sm text-[var(--color-ink-3)]">—</li>
        )}
      </ul>
    </div>
  )
}
