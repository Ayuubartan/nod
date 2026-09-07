import { prisma } from '@/lib/db'
import { requireBrandScope } from '@/lib/auth'
import { campaignBalances } from '@/lib/money/balances'
import { formatOre } from '@/lib/money/calc'
import { RolloverPreference } from '@/components/brand/RolloverPreference'

/** Brand settings — docs/02 B3: org details, users, billing history. */
export const dynamic = 'force-dynamic'

export default async function BrandSettingsPage() {
  const { brandId } = await requireBrandScope()
  if (!brandId) {
    // Ops has no brand of its own to show settings for.
    return <p className="card p-8 text-center text-sm text-[var(--color-ink-3)]">No brand selected.</p>
  }

  const brand = await prisma.brand.findUniqueOrThrow({
    where: { id: brandId },
    include: {
      users: { where: { deletedAt: null } },
      campaigns: { select: { id: true, name: true, state: true, fundedVia: true, fundedAt: true } },
    },
  })

  const balances = await campaignBalances(prisma, brand.campaigns.map((c) => c.id))

  return (
    <div className="grid gap-8 max-w-3xl">
      <section>
        <h1 className="text-xl mb-4">{brand.name}</h1>
        <dl className="card p-4 grid sm:grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-[var(--color-ink-2)]">Org number</dt>
            <dd className="tabular">{brand.orgNumber ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-2)]">Invoice terms</dt>
            <dd>{brand.invoiceWhitelisted ? 'Approved' : 'Prepaid only'}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h2 className="label">Unspent budget at close</h2>
        <RolloverPreference brandId={brand.id} preference={brand.rolloverPreference as 'refund' | 'rollover'} />
      </section>

      <section>
        <h2 className="label">Users</h2>
        <ul className="card divide-y divide-[var(--color-line)]">
          {brand.users.map((user) => (
            <li key={user.id} className="px-4 py-3 flex items-center justify-between text-sm">
              <span>{user.email}</span>
              <span className="chip text-xs">{user.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="label">Billing history</h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)]">
                <th className="text-left font-semibold px-4 py-3">Campaign</th>
                <th className="text-left font-semibold px-4 py-3">Funded</th>
                <th className="text-right font-semibold px-4 py-3">Deposited</th>
                <th className="text-right font-semibold px-4 py-3">Spent</th>
                <th className="text-right font-semibold px-4 py-3">Refunded</th>
              </tr>
            </thead>
            <tbody>
              {brand.campaigns.map((campaign) => {
                const balance = balances.get(campaign.id)
                return (
                  <tr key={campaign.id} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-4 py-3">{campaign.name}</td>
                    <td className="px-4 py-3 text-[var(--color-ink-2)]">
                      {campaign.fundedAt ? `${campaign.fundedVia} · ${campaign.fundedAt.toLocaleDateString('sv-SE')}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular">{formatOre(balance?.depositedOre ?? 0)}</td>
                    <td className="px-4 py-3 text-right tabular">{formatOre(balance?.spentOre ?? 0)}</td>
                    <td className="px-4 py-3 text-right tabular">{formatOre(balance?.refundedOre ?? 0)}</td>
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
