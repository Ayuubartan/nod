import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { requireBrandUser } from '@/lib/auth'
import { mediaUrl } from '@/lib/media-url'
import { AssetUploader } from '@/components/brand/AssetUploader'

/** Campaign assets — docs/02 B1 step 3. */
export const dynamic = 'force-dynamic'

export default async function CampaignAssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { assets: { where: { deletedAt: null } } },
  })
  if (!campaign) notFound()

  await requireBrandUser(campaign.brandId)

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl mb-1">Assets</h1>
      <p className="text-sm text-[var(--color-ink-2)] mb-6">
        Products and logos participants can place. PNG with transparency works best.
      </p>

      <ul className="grid gap-3 sm:grid-cols-2 mb-6">
        {campaign.assets.map((asset) => (
          <li key={asset.id} className="card p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaUrl(asset.storagePath)}
              alt={asset.name}
              className="w-full h-32 object-contain bg-[var(--color-bg)] rounded mb-2"
            />
            <p className="text-sm font-medium">{asset.name}</p>
            <p className="text-xs text-[var(--color-ink-3)]">{asset.placementTypes.join(', ') || '—'}</p>
          </li>
        ))}
        {campaign.assets.length === 0 && (
          <li className="card p-8 text-center text-sm text-[var(--color-ink-3)] sm:col-span-2">
            No assets yet.
          </li>
        )}
      </ul>

      <AssetUploader campaignId={campaign.id} />
    </div>
  )
}
