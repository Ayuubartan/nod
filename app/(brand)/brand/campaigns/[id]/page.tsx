import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireBrandUser } from '@/lib/auth'
import { campaignBalance } from '@/lib/money/balances'
import { effectiveCpmOre, formatKrDown, formatOre } from '@/lib/money/calc'
import { StateChip } from '@/components/StateChip'
import { FundButton } from '@/components/brand/FundButton'
import { DailyViewsChart } from '@/components/brand/DailyViewsChart'

/**
 * Campaign dashboard — docs/02 B2.
 *
 * The spent / reserved / available trio at the top is the brand-side signature
 * (docs/10). All three are derived from the ledger, never stored.
 */
export const dynamic = 'force-dynamic'

export default async function BrandCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('brandApp')

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { brand: { select: { id: true, name: true } }, payoutTemplate: true },
  })
  if (!campaign) notFound()

  await requireBrandUser(campaign.brandId)

  const [balance, placements, verifications] = await Promise.all([
    campaignBalance(prisma, campaign.id),
    prisma.placement.findMany({
      where: { campaignId: campaign.id, deletedAt: null },
      include: {
        // Brands see the handle and the public post link, never contact or identity
        // data (docs/07 section 3).
        account: { select: { handle: true, platform: true } },
        user: { select: { city: true } },
        verification: { select: { views: true, qualifiedViews: true, disclosureOk: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.verification.findMany({
      where: { placement: { campaignId: campaign.id } },
      select: { qualifiedViews: true, decidedAt: true },
    }),
  ])

  const totalQualified = verifications.reduce((sum, v) => sum + (v.qualifiedViews ?? 0), 0)
  const totalViews = placements.reduce((sum, p) => sum + (p.verification?.views ?? 0), 0)
  const participants = new Set(placements.map((p) => p.userId)).size
  const cpm = effectiveCpmOre(balance.spentOre, totalQualified)
  const pendingReview = placements.filter((p) => p.state === 'BRAND_REVIEW').length

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

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div>
          <p className="text-sm text-[var(--color-ink-2)]">{campaign.brand.name}</p>
          <h1 className="text-2xl">{campaign.name}</h1>
          {campaign.startsAt && campaign.endsAt && (
            <p className="text-sm text-[var(--color-ink-3)] tabular">
              {campaign.startsAt.toLocaleDateString('sv-SE')} – {campaign.endsAt.toLocaleDateString('sv-SE')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="chip text-xs">{campaign.state}</span>
          {campaign.state === 'AWAITING_FUNDS' && <FundButton campaignId={campaign.id} />}
          {pendingReview > 0 && (
            <Link
              href={`/brand/campaigns/${campaign.id}/review`}
              className="btn text-white text-sm"
              style={{ background: 'var(--color-blue)' }}
            >
              {t('reviewQueue')} · {pendingReview}
            </Link>
          )}
        </div>
      </header>

      {/* The signature trio. */}
      <ul className="grid gap-3 sm:grid-cols-3 mb-6">
        {money.map((item) => (
          <li key={item.label} className="card p-4">
            <p className="text-xs text-[var(--color-ink-2)] mb-1">{item.label}</p>
            <p className="amount text-2xl font-bold">{formatOre(item.value)}</p>
          </li>
        ))}
      </ul>

      <ul className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-8">
        {kpis.map((kpi) => (
          <li key={kpi.label} className="card p-4">
            <p className="text-xs text-[var(--color-ink-2)] mb-1">{kpi.label}</p>
            <p className="amount text-xl font-semibold">{kpi.value}</p>
          </li>
        ))}
      </ul>

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
                <th className="text-left font-semibold px-4 py-3">@</th>
                <th className="text-left font-semibold px-4 py-3">City</th>
                <th className="text-right font-semibold px-4 py-3">Views</th>
                <th className="text-right font-semibold px-4 py-3">{t('qualifiedViews')}</th>
                <th className="text-center font-semibold px-4 py-3">✓</th>
                <th className="text-left font-semibold px-4 py-3">State</th>
                <th className="text-left font-semibold px-4 py-3">Post</th>
              </tr>
            </thead>
            <tbody>
              {placements.map((placement) => (
                <tr key={placement.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="px-4 py-3">@{placement.account.handle}</td>
                  <td className="px-4 py-3 text-[var(--color-ink-2)]">{placement.user.city ?? '—'}</td>
                  <td className="px-4 py-3 text-right tabular">
                    {placement.verification?.views?.toLocaleString('sv-SE') ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular font-semibold">
                    {placement.verification?.qualifiedViews?.toLocaleString('sv-SE') ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {placement.verification?.disclosureOk ? '✓' : placement.verification ? '✗' : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StateChip state={placement.state} />
                  </td>
                  <td className="px-4 py-3">
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
              ))}
              {placements.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                    —
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {campaign.state === 'RECONCILING' && (
        <p className="mt-6">
          <Link href={`/brand/campaigns/${campaign.id}/report`} className="btn btn-secondary">
            {t('report')}
          </Link>
        </p>
      )}

      <p className="mt-6 text-xs text-[var(--color-ink-3)] tabular">
        {totalViews.toLocaleString('sv-SE')} total views · {formatOre(balance.depositedOre)} deposited
      </p>
    </div>
  )
}
