import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireBrandUser } from '@/lib/auth'
import { inFlightByAsset } from '@/lib/creative'
import { AssetUploader } from '@/components/brand/AssetUploader'
import { CampaignHeader } from '@/components/brand/CampaignHeader'
import { CampaignTabs } from '@/components/brand/CampaignTabs'
import { CreativeManager } from '@/components/brand/CreativeManager'

/**
 * Campaign creative — docs/02 B1 step 3, plus the distribution-layer controls: which
 * asset is in how many placements right now, and swapping it for a new one.
 */
export const dynamic = 'force-dynamic'

export default async function CampaignAssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('brandApp')

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      brand: { select: { name: true } },
      assets: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
    },
  })
  if (!campaign) notFound()

  await requireBrandUser(campaign.brandId)

  const [inFlight, pendingReview] = await Promise.all([
    inFlightByAsset(campaign.id),
    prisma.placement.count({ where: { campaignId: campaign.id, state: 'BRAND_REVIEW', deletedAt: null } }),
  ])

  return (
    <div>
      <CampaignHeader campaign={campaign} brandName={campaign.brand.name} />
      <CampaignTabs
        campaignId={campaign.id}
        active="creative"
        reviewCount={pendingReview}
        showReport={campaign.state === 'RECONCILING' || campaign.state === 'CLOSED'}
      />

      <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
        <section>
          <h2 className="label">{t('creativeSection.title')}</h2>
          <CreativeManager
            campaignId={campaign.id}
            assets={campaign.assets.map((asset) => ({
              id: asset.id,
              name: asset.name,
              storagePath: asset.storagePath,
              placementTypes: asset.placementTypes,
              inFlight: inFlight.get(asset.id) ?? 0,
            }))}
          />
        </section>

        <section>
          <h2 className="label">{t('creativeSection.add')}</h2>
          <AssetUploader campaignId={campaign.id} />
          <p className="text-xs text-[var(--color-ink-3)] mt-3">{t('creativeSection.hint')}</p>
        </section>
      </div>
    </div>
  )
}
