import Link from 'next/link'
import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { CreateBrandForm } from '@/components/ops/CreateBrandForm'
import { InvoiceWhitelistToggle } from '@/components/ops/InvoiceWhitelistToggle'

/**
 * Brands — docs/02 section C: "create org, invite user, view campaigns".
 * There is no self-serve brand signup in the pilot (docs/09 "Not in scope").
 */
export const dynamic = 'force-dynamic'

export default async function OpsBrandsPage() {
  await requireOps()

  const brands = await prisma.brand.findMany({
    where: { deletedAt: null },
    include: {
      users: { where: { deletedAt: null } },
      campaigns: { select: { id: true, name: true, state: true }, orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return (
    <div className="grid gap-8">
      <section>
        <h1 className="text-xl mb-4">New brand</h1>
        <CreateBrandForm />
      </section>

      <section>
        <h2 className="text-xl mb-4">Brands</h2>
        <ul className="grid gap-4">
          {brands.map((brand) => (
            <li key={brand.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div>
                  <p className="font-semibold">{brand.name}</p>
                  <p className="text-xs text-[var(--color-ink-3)] tabular">{brand.orgNumber ?? '—'}</p>
                </div>
                <InvoiceWhitelistToggle brandId={brand.id} whitelisted={brand.invoiceWhitelisted} />
              </div>

              <dl className="grid sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="text-[var(--color-ink-3)] mb-1">Users</dt>
                  <dd>
                    <ul className="grid gap-0.5">
                      {brand.users.map((user) => (
                        <li key={user.id}>
                          {user.email} <span className="text-[var(--color-ink-3)]">{user.role}</span>
                        </li>
                      ))}
                      {brand.users.length === 0 && <li className="text-[var(--color-ink-3)]">—</li>}
                    </ul>
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--color-ink-3)] mb-1">Campaigns</dt>
                  <dd>
                    <ul className="grid gap-0.5">
                      {brand.campaigns.map((campaign) => (
                        <li key={campaign.id}>
                          <Link href={`/brand/campaigns/${campaign.id}`} className="underline">
                            {campaign.name}
                          </Link>{' '}
                          <span className="text-[var(--color-ink-3)]">{campaign.state}</span>
                        </li>
                      ))}
                      {brand.campaigns.length === 0 && <li className="text-[var(--color-ink-3)]">—</li>}
                    </ul>
                  </dd>
                </div>
              </dl>
            </li>
          ))}
          {brands.length === 0 && (
            <li className="card p-8 text-center text-sm text-[var(--color-ink-3)]">No brands yet.</li>
          )}
        </ul>
      </section>
    </div>
  )
}
