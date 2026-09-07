import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireBrandUser } from '@/lib/auth'
import { campaignBalance } from '@/lib/money/balances'
import { effectiveCpmOre, formatKrDown, formatOre } from '@/lib/money/calc'
import { mediaUrl } from '@/lib/media-url'
import { inFlightByAsset } from '@/lib/creative'
import { StateChip } from '@/components/StateChip'
import { CampaignHeader } from '@/components/brand/CampaignHeader'
import { CampaignTabs } from '@/components/brand/CampaignTabs'
import { DailyViewsChart } from '@/components/brand/DailyViewsChart'
import { FillBar, fillPercent } from '@/components/brand/FillBar'
import { Funnel } from '@/components/brand/Funnel'

/**
 * Campaign dashboard — docs/02 B2.
 *
 * The spent / reserved / available trio at the top is the brand-side signature
 * (docs/10). All three are derived from the ledger, never stored. Under it: the fill bar,
 * the placement funnel, the creative that is currently being distributed, and the
 * placements themselves with the actual images.
 */
export const dynamic = 'force-dynamic'

export default async function BrandCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('brandApp')

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      brand: { select: { id: true, name: true } },
      payoutTemplate: true,
      assets: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
    },
  })
  if (!campaign) notFound()

  await requireBrandUser(campaign.brandId)

  const [balance, placements, verifications, inFlight] = await Promise.all([
    campaignBalance(prisma, campaign.id),
    prisma.placement.findMany({
      where: { campaignId: campaign.id, deletedAt: null },
      include: {
        // Brands see the handle and the public post link, never contact or identity
        // data (docs/07 section 3).
        account: { select: { handle: true, platform: true } },
        user: { select: { city: true } },
        verification: { select: { views: true, qualifiedViews: true, disclosureOk: true } },
        versions: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1, select: { storagePath: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.verification.findMany({
      where: { placement: { campaignId: campaign.id } },
      select: { qualifiedViews: true, decidedAt: true },
    }),
    inFlightByAsset(campaign.id),
  ])

  const totalQualified = verifications.reduce((sum, v) => sum + (v.qualifiedViews ?? 0), 0)
  const totalViews = placements.reduce((sum, p) => sum + (p.verification?.views ?? 0), 0)
  const participants = new Set(placements.map((p) => p.userId)).size
  const cpm = effectiveCpmOre(balance.spentOre, totalQualified)
  const pendingReview = placements.filter((p) => p.state === 'BRAND_REVIEW').length
  const showReport = campaign.state === 'RECONCILING' || campaign.state === 'CLOSED'

  const daily = new Map<string, number>()
  for (const v of verifications) {
    if (!v.decidedAt) continue
    const day = v.decidedAt.toISOString().slice(0, 10)
    daily.set(day, (daily.get(day) ?? 0) + (v.qualifiedViews ?? 0))
  }

  const money = [
    { label: t('spent'), value: balance.spentOre },
    { label: t('reserved'), value: balance.reservedOre },
    { label: t('available'), value: balance.availableOre },
  ]

  const kpis = [
    { label: t('participants'), value: participants.toLocaleString('sv-SE') },
    { label: t('placements'), value: placements.length.toLocaleString('sv-SE') },
    { label: t('qualifiedViews'), value: totalQualified.toLocaleString('sv-SE') },
    { label: t('effectiveCpm'), value: formatKrDown(cpm) },
  ]

  const pct = (ore: number) => (balance.budgetOre > 0 ? Math.round((ore / balance.budgetOre) * 100) : 0)

  return (
    <div>
      <CampaignHeader
        campaign={campaign}
        brandName={campaign.brand.name}
        actions={
          pendingReview > 0 ? (
            <Link
              href={`/brand/campaigns/${campaign.id}/review`}
              className="btn text-white text-sm"
              style={{ background: 'var(--color-blue)' }}
            >
              {t('reviewQueue')} · {pendingReview}
            </Link>
          ) : null
        }
      />

      <CampaignTabs campaignId={campaign.id} active="overview" reviewCount={pendingReview} showReport={showReport} />

      {/* The signature trio, with the fill bar under it. */}
      <section className="card p-4 mb-6">
        <ul className="grid gap-4 sm:grid-cols-3">
          {money.map((item) => (
            <li key={item.label}>
              <p className="text-xs text-[var(--color-ink-2)] mb-1">{item.label}</p>
              <p className="amount text-2xl font-bold">{formatOre(item.value)}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-[var(--color-ink-2)] mb-1.5 tabular">
            <span>
              {t('fill')} · {t('ofBudget', { percent: fillPercent(balance) })}
            </span>
            <span>
              {pct(balance.spentOre)}% {t('spentShare')} · {pct(balance.reservedOre)}% {t('reservedShare')} ·{' '}
              {t('budget')} {formatOre(balance.budgetOre)}
            </span>
          </div>
          <FillBar balance={balance} />
        </div>
      </section>

      <ul className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-6">
        {kpis.map((kpi) => (
          <li key={kpi.label} className="card p-4">
            <p className="text-xs text-[var(--color-ink-2)] mb-1">{kpi.label}</p>
            <p className="amount text-xl font-semibold">{kpi.value}</p>
          </li>
        ))}
      </ul>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr] mb-8">
        <section>
          <h2 className="label">{t('funnel.title')}</h2>
          <Funnel states={placements.map((p) => p.state)} reviewHref={`/brand/campaigns/${campaign.id}/review`} />
        </section>

        <section>
          <div className="flex items-center justify-between">
            <h2 className="label">{t('creativeSection.title')}</h2>
            <Link href={`/brand/campaigns/${campaign.id}/assets`} className="text-xs underline">
              {t('creativeSection.manage')}
            </Link>
          </div>
          <div className="card p-3">
            {campaign.assets.length === 0 ? (
              <p className="text-sm text-[var(--color-ink-3)] py-4 text-center">{t('creativeSection.none')}</p>
            ) : (
              <ul className="grid grid-cols-3 gap-2">
                {campaign.assets.map((asset) => (
                  <li key={asset.id} className="text-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={mediaUrl(asset.storagePath)}
                      alt={asset.name}
                      className="w-full aspect-square object-contain rounded bg-[var(--color-bg)]"
                    />
                    <p className="text-xs mt-1 truncate">{asset.name}</p>
                    <p className="text-[11px] text-[var(--color-ink-3)] tabular">
                      {t('creativeSection.inFlight', { count: inFlight.get(asset.id) ?? 0 })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-[var(--color-ink-3)] mt-3">{t('creativeSection.inFlightHint')}</p>
          </div>
        </section>
      </div>

      {daily.size > 0 && (
        <section className="mb-8">
          <h2 className="label">{t('qualifiedViews')}</h2>
          <DailyViewsChart data={[...daily.entries()].sort().map(([day, views]) => ({ day, views }))} />
        </section>
      )}

      <section>
        <h2 className="label">{t('placements')}</h2>
        <div className="overflow-x-auto card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)]">
                <th className="text-left font-semibold px-3 py-3">{t('table.image')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('table.handle')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('table.city')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('table.type')}</th>
                <th className="text-right font-semibold px-3 py-3">{t('table.views')}</th>
                <th className="text-right font-semibold px-3 py-3">{t('table.qualified')}</th>
                <th className="text-center font-semibold px-3 py-3">{t('table.disclosure')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('table.state')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('table.post')}</th>
              </tr>
            </thead>
            <tbody>
              {placements.map((placement) => {
                const version = placement.versions[0]
                return (
                  <tr key={placement.id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-3 py-2">
                      {version ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={mediaUrl(version.storagePath)}
                          alt=""
                          className="w-12 h-12 rounded object-cover bg-[var(--color-bg)]"
                        />
                      ) : (
                        <span className="block w-12 h-12 rounded bg-[var(--color-bg)]" />
                      )}
                    </td>
                    <td className="px-3 py-2">@{placement.account.handle}</td>
                    <td className="px-3 py-2 text-[var(--color-ink-2)]">{placement.user.city ?? '—'}</td>
                    <td className="px-3 py-2 text-[var(--color-ink-2)]">{placement.contentType ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular">
                      {placement.verification?.views?.toLocaleString('sv-SE') ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular font-semibold">
                      {placement.verification?.qualifiedViews?.toLocaleString('sv-SE') ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {placement.verification?.disclosureOk ? '✓' : placement.verification ? '✗' : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <StateChip state={placement.state} perspective="brand" />
                    </td>
                    <td className="px-3 py-2">
                      {placement.postUrl ? (
                        <a
                          href={placement.postUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline text-[var(--color-blue)]"
                        >
                          ↗
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
              {placements.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                    {t('table.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showReport && (
        <p className="mt-6">
          <Link href={`/brand/campaigns/${campaign.id}/report`} className="btn btn-secondary">
            {t('report')}
          </Link>
        </p>
      )}

      <p className="mt-6 text-xs text-[var(--color-ink-3)] tabular">
        {totalViews.toLocaleString('sv-SE')} {t('totalViews')} · {formatOre(balance.depositedOre)} {t('deposited')}
      </p>
    </div>
  )
}
