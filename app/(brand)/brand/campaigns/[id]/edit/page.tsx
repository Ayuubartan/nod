import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { requireBrandUser } from '@/lib/auth'
import { flag } from '@/lib/flags'
import { CampaignBuilder } from '@/components/brand/CampaignBuilder'
import { measureHistoricalRates } from '@/lib/fill-model'

/** Campaign builder — docs/02 B1. */
export const dynamic = 'force-dynamic'

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { payoutTemplate: true },
  })
  if (!campaign) notFound()

  await requireBrandUser(campaign.brandId)

  // Tier B is mandatory until this brand has run a campaign to completion.
  const [priorCampaigns, forceFlag] = await Promise.all([
    prisma.campaign.count({
      where: { brandId: campaign.brandId, state: { in: ['CLOSED', 'RECONCILING'] }, id: { not: id } },
    }),
    flag('review.firstCampaignForcesTierB'),
  ])

  // Inputs to the fill-rate heuristic (docs/02 B1 step 5).
  const eligible = await prisma.socialAccount.findMany({
    where: {
      deletedAt: null,
      tier: { in: ['CONNECTED_API', 'CONNECTED_SCREENSHOT'] },
      followers: { gte: campaign.minFollowers },
      user: {
        state: { in: ['VERIFIED', 'ACTIVE'] },
        deletedAt: null,
        ...(campaign.cities.length > 0 ? { city: { in: campaign.cities } } : {}),
      },
    },
    select: { avgViews30d: true },
    take: 5_000,
  })

  const sorted = eligible.map((a) => a.avgViews30d).sort((a, b) => a - b)
  const medianAvgViews = sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0

  // Measured claim and completion rates from campaigns that have run to completion.
  // Null until there is history, in which case the builder falls back to the heuristic
  // and says so (docs/09 M5 task 5).
  const rates = await measureHistoricalRates()

  return (
    <div>
      <h1 className="text-2xl mb-6">{campaign.name}</h1>
      <CampaignBuilder
        draft={{
          id: campaign.id,
          name: campaign.name,
          kind: campaign.kind,
          platforms: campaign.platforms,
          requiredHashtags: campaign.requiredHashtags,
          requiredMentions: campaign.requiredMentions,
          validationHours: campaign.validationHours,
          startsAt: campaign.startsAt?.toISOString() ?? null,
          endsAt: campaign.endsAt?.toISOString() ?? null,
          goLiveAt: campaign.goLiveAt?.toISOString() ?? null,
          cities: campaign.cities,
          ageBrackets: campaign.ageBrackets,
          minFollowers: campaign.minFollowers,
          maxFollowers: campaign.maxFollowers,
          categories: campaign.categories,
          exclusions: campaign.exclusions,
          rulesText: campaign.rulesText,
          brandSafety: campaign.brandSafety,
          reviewTier: campaign.reviewTier,
          disclosureText: campaign.disclosureText,
          budget: campaign.budget,
          perPlacementMax: campaign.perPlacementMax,
          perPersonCap: campaign.perPersonCap,
          fundedVia: campaign.fundedVia,
          state: campaign.state,
          forceTierB: forceFlag && priorCampaigns === 0,
          template: campaign.payoutTemplate
            ? {
                kind: campaign.payoutTemplate.kind,
                fixedOre: campaign.payoutTemplate.fixedOre,
                cpmOre: campaign.payoutTemplate.cpmOre,
                bonusAtViews: campaign.payoutTemplate.bonusAtViews,
                bonusOre: campaign.payoutTemplate.bonusOre,
                viewFloor: campaign.payoutTemplate.viewFloor,
              }
            : null,
          eligibleAccounts: eligible.length,
          medianAvgViews,
          rates,
        }}
      />
    </div>
  )
}
