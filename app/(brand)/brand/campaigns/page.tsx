import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { getSession, requireBrandUser } from '@/lib/auth'
import { campaignBalances } from '@/lib/money/balances'
import { formatOre } from '@/lib/money/calc'
import { NewCampaignButton } from '@/components/brand/NewCampaignButton'

/** Campaign index — docs/02 section B. */
export const dynamic = 'force-dynamic'

export default async function BrandCampaignsPage() {
  const session = await getSession()
  const t = await getTranslations('brandApp')

  // Ops browsing the brand surface sees every brand; a brand user sees only their own.
  const brandId = session?.kind === 'brand' ? session.brandUser.brandId : undefined
  if (brandId) await requireBrandUser(brandId)

  const campaigns = await prisma.campaign.findMany({
    where: { deletedAt: null, ...(brandId ? { brandId } : {}) },
    include: { brand: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const balances = await campaignBalances(prisma, campaigns.map((c) => c.id))

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl">{t('campaigns')}</h1>
        {brandId && <NewCampaignButton brandId={brandId} label={t('newCampaign')} />}
      </div>

      <ul className="grid gap-3">
        {campaigns.map((campaign) => {
          const balance = balances.get(campaign.id)
          return (
            <li key={campaign.id}>
              <Link href={`/brand/campaigns/${campaign.id}`} className="card p-4 block">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="text-sm text-[var(--color-ink-2)]">{campaign.brand.name}</p>
                    <h2 className="font-semibold">{campaign.name}</h2>
                  </div>
                  <span className="chip text-xs">{campaign.state}</span>
                </div>

                {balance && (
                  <dl className="grid grid-cols-3 gap-3 text-sm">
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
                  </dl>
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
