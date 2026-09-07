import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireParticipant } from '@/lib/auth'
import { campaignBalance } from '@/lib/money/balances'
import { evaluateEligibility } from '@/lib/marketplace'
import { formatKrDown, participantRateCard } from '@/lib/money/calc'
import { ClaimButton } from '@/components/participant/ClaimButton'

/** Campaign detail — docs/02 A2. Shows the exact disclosure the participant will use. */
export const dynamic = 'force-dynamic'

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireParticipant()
  const t = await getTranslations('campaigns.detail')
  const tc = await getTranslations('campaigns')
  const common = await getTranslations('common')

  const campaign = await prisma.campaign.findFirst({
    where: { id, deletedAt: null, state: { in: ['LIVE', 'FILLING'] } },
    include: { payoutTemplate: true, assets: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } }, brand: { select: { name: true } } },
  })
  if (!campaign) notFound()

  const [accounts, balance, existingPlacements] = await Promise.all([
    prisma.socialAccount.findMany({ where: { userId: user.id, deletedAt: null } }),
    campaignBalance(prisma, campaign.id),
    prisma.placement.count({
      where: {
        campaignId: campaign.id,
        userId: user.id,
        deletedAt: null,
        state: { notIn: ['EXPIRED', 'REJECTED_BY_PARTICIPANT'] },
      },
    }),
  ])

  const eligibility = evaluateEligibility({
    campaign,
    user,
    accounts,
    availableOre: balance.availableOre,
    existingPlacements,
  })

  const rates = campaign.payoutTemplate ? participantRateCard(campaign.payoutTemplate) : null
  const disclosure = campaign.disclosureText.replace('{brand}', campaign.brand.name)
  const claimable = accounts.filter((a) => a.tier === 'CONNECTED_API' || a.tier === 'CONNECTED_SCREENSHOT')

  return (
    <article>
      <p className="text-sm text-[var(--color-ink-2)]">{campaign.brand.name}</p>
      <h1 className="text-2xl mb-5">{campaign.name}</h1>

      {rates && (
        <section className="card p-4 mb-4">
          <h2 className="label">{t('payout')}</h2>
          <p className="amount text-xl font-bold">
            {formatKrDown(rates.fixedOre)} {common('perPost')}
          </p>
          <p className="amount text-xl font-bold">
            + {formatKrDown(rates.cpmOre)} {common('perThousandViews')}
          </p>
        </section>
      )}

      {campaign.assets.length > 0 && (
        <section className="mb-4">
          <h2 className="label">{t('products')}</h2>
          <ul className="flex flex-wrap gap-2">
            {campaign.assets.map((asset) => (
              <li key={asset.id} className="chip">
                {asset.name}
              </li>
            ))}
          </ul>
        </section>
      )}

      {campaign.rulesText && (
        <section className="mb-4">
          <h2 className="label">{t('rules')}</h2>
          <p className="text-sm text-[var(--color-ink-2)] whitespace-pre-line">{campaign.rulesText}</p>
        </section>
      )}

      <section className="mb-4">
        <h2 className="label">{t('disclosure')}</h2>
        <p className="card px-3 py-2 text-sm tabular">{disclosure}</p>
      </section>

      {campaign.endsAt && (
        <section className="mb-6">
          <h2 className="label">{t('period')}</h2>
          <p className="text-sm text-[var(--color-ink-2)]">
            {campaign.startsAt?.toLocaleDateString('sv-SE')} – {campaign.endsAt.toLocaleDateString('sv-SE')}
          </p>
        </section>
      )}

      {eligibility.eligible ? (
        <ClaimButton
          campaignId={campaign.id}
          accounts={claimable.map((a) => ({
            id: a.id,
            handle: a.handle,
            platform: a.platform,
            avgViews30d: a.avgViews30d,
          }))}
          defaultAccountId={eligibility.account.id}
          estimateLabel={formatKrDown(eligibility.estimateOre)}
        />
      ) : eligibility.reason === 'notVerified' ? (
        <Link href="/verify" className="btn btn-primary w-full">
          {tc('reasons.notVerified')}
        </Link>
      ) : (
        <p className="card p-4 text-sm text-[var(--color-ink-2)]">
          {tc(`reasons.${eligibility.reason}`, {
            min: eligibility.detail ?? '',
            cities: eligibility.detail ?? '',
          })}
        </p>
      )}
    </article>
  )
}
