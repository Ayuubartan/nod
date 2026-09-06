import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { campaignBalances } from '@/lib/money/balances'
import { formatOre } from '@/lib/money/calc'
import { OpsCampaignActions } from '@/components/ops/OpsCampaignActions'

/** Campaign review — docs/02 section C. */
export const dynamic = 'force-dynamic'

export default async function OpsCampaignsPage() {
  await requireOps()

  const campaigns = await prisma.campaign.findMany({
    where: { deletedAt: null },
    include: {
      brand: { select: { name: true, invoiceWhitelisted: true } },
      payoutTemplate: true,
      _count: { select: { placements: true } },
    },
    orderBy: [{ state: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  })

  const balances = await campaignBalances(prisma, campaigns.map((c) => c.id))

  const submitted = campaigns.filter((c) => c.state === 'SUBMITTED')
  const rest = campaigns.filter((c) => c.state !== 'SUBMITTED')

  return (
    <div className="grid gap-8">
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h1 className="text-xl">Awaiting review</h1>
          <p className="text-sm text-[var(--color-ink-2)] tabular">
            {submitted.length} · 2 business day SLA
          </p>
        </div>

        {submitted.length === 0 ? (
          <p className="card p-6 text-center text-sm text-[var(--color-ink-3)]">Nothing to review.</p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {submitted.map((campaign) => (
              <li key={campaign.id} className="card p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="font-semibold">{campaign.brand.name}</p>
                    <p className="text-sm text-[var(--color-ink-2)]">{campaign.name}</p>
                  </div>
                  <span className="chip text-xs">Tier {campaign.reviewTier}</span>
                </div>

                <dl className="grid grid-cols-2 gap-2 text-xs mb-3">
                  <div>
                    <dt className="text-[var(--color-ink-3)]">Budget</dt>
                    <dd className="tabular font-semibold">{formatOre(campaign.budget)}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-ink-3)]">Payout</dt>
                    <dd className="tabular">
                      {campaign.payoutTemplate
                        ? `${formatOre(campaign.payoutTemplate.fixedOre)} + ${formatOre(campaign.payoutTemplate.cpmOre)}/1k`
                        : '—'}
                    </dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[var(--color-ink-3)]">Disclosure</dt>
                    <dd>{campaign.disclosureText}</dd>
                  </div>
                  {campaign.rulesText && (
                    <div className="col-span-2">
                      <dt className="text-[var(--color-ink-3)]">Rules</dt>
                      <dd className="whitespace-pre-line">{campaign.rulesText}</dd>
                    </div>
                  )}
                </dl>

                <OpsCampaignActions campaignId={campaign.id} state={campaign.state} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-xl mb-4">All campaigns</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)]">
                <th className="text-left font-semibold px-4 py-3">Brand</th>
                <th className="text-left font-semibold px-4 py-3">Campaign</th>
                <th className="text-left font-semibold px-4 py-3">State</th>
                <th className="text-right font-semibold px-4 py-3">Spent</th>
                <th className="text-right font-semibold px-4 py-3">Reserved</th>
                <th className="text-right font-semibold px-4 py-3">Available</th>
                <th className="text-right font-semibold px-4 py-3">Placements</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rest.map((campaign) => {
                const balance = balances.get(campaign.id)
                return (
                  <tr key={campaign.id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-4 py-3">{campaign.brand.name}</td>
                    <td className="px-4 py-3">
                      <Link href={`/brand/campaigns/${campaign.id}`} className="underline">
                        {campaign.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="chip text-xs">{campaign.state}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular">{formatOre(balance?.spentOre ?? 0)}</td>
                    <td className="px-4 py-3 text-right tabular">{formatOre(balance?.reservedOre ?? 0)}</td>
                    <td className="px-4 py-3 text-right tabular">{formatOre(balance?.availableOre ?? 0)}</td>
                    <td className="px-4 py-3 text-right tabular">{campaign._count.placements}</td>
                    <td className="px-4 py-3">
                      <OpsCampaignActions campaignId={campaign.id} state={campaign.state} compact />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
