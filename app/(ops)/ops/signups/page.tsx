import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'

/**
 * Signups — everyone who raised a hand, newest first: waitlist entries and brand
 * enquiries from the marketing site, and accounts created through sign-in. Before
 * launch this is the list that matters; the participant and brand pages only show
 * people once they are inside the product.
 */
export const dynamic = 'force-dynamic'

const TAKE = 200

export default async function OpsSignupsPage() {
  await requireOps()

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const [waitlist, enquiries, users, weekWaitlist, weekUsers] = await Promise.all([
    prisma.waitlistEntry.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: TAKE }),
    prisma.brandEnquiry.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: TAKE }),
    prisma.user.findMany({
      where: { role: 'PARTICIPANT', deletedAt: null },
      select: { id: true, email: true, city: true, state: true, createdAt: true, referredBy: { select: { referralCode: true } } },
      orderBy: { createdAt: 'desc' },
      take: TAKE,
    }),
    prisma.waitlistEntry.count({ where: { deletedAt: null, createdAt: { gte: since } } }),
    prisma.user.count({ where: { role: 'PARTICIPANT', deletedAt: null, createdAt: { gte: since } } }),
  ])
  const [waitlistTotal, enquiryTotal, userTotal] = await Promise.all([
    prisma.waitlistEntry.count({ where: { deletedAt: null } }),
    prisma.brandEnquiry.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { role: 'PARTICIPANT', deletedAt: null } }),
  ])

  const totals = [
    { label: 'Waitlist', value: waitlistTotal, week: weekWaitlist },
    { label: 'Accounts', value: userTotal, week: weekUsers },
    { label: 'Brand enquiries', value: enquiryTotal, week: null },
  ]

  const when = (d: Date) => d.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-xl">Signups</h1>
        {/* Route handlers, not actions: a download is a navigation. Every export is audited. */}
        <div className="flex gap-2">
          <a href="/ops/signups/export?kind=waitlist" className="btn btn-secondary text-sm">
            Download waitlist CSV
          </a>
          <a href="/ops/signups/export?kind=enquiries" className="btn btn-secondary text-sm">
            Download enquiries CSV
          </a>
        </div>
      </div>

      <ul className="grid gap-3 sm:grid-cols-3 mb-8">
        {totals.map((total) => (
          <li key={total.label} className="card p-4">
            <p className="text-xs text-[var(--color-ink-2)] mb-1">{total.label}</p>
            <p className="amount text-3xl font-bold">{total.value}</p>
            {total.week !== null && (
              <p className="text-xs text-[var(--color-ink-3)] mt-1">+{total.week} last 7 days</p>
            )}
          </li>
        ))}
      </ul>

      <h2 className="text-base font-semibold mb-2">Waitlist</h2>
      <div className="card overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              <th className="text-left font-semibold px-4 py-3">When</th>
              <th className="text-left font-semibold px-4 py-3">Handle</th>
              <th className="text-left font-semibold px-4 py-3">Email</th>
              <th className="text-left font-semibold px-4 py-3">City</th>
              <th className="text-left font-semibold px-4 py-3">Verified</th>
              <th className="text-left font-semibold px-4 py-3">Points</th>
              <th className="text-left font-semibold px-4 py-3">Level</th>
              <th className="text-left font-semibold px-4 py-3">Age</th>
              <th className="text-left font-semibold px-4 py-3">Followers</th>
              <th className="text-left font-semibold px-4 py-3">Categories</th>
              <th className="text-left font-semibold px-4 py-3">Referred by</th>
            </tr>
          </thead>
          <tbody>
            {waitlist.map((entry) => (
              <tr key={entry.id} className="border-b border-[var(--color-line)] last:border-0 align-top">
                <td className="px-4 py-3 tabular whitespace-nowrap text-[var(--color-ink-2)]">{when(entry.createdAt)}</td>
                <td className="px-4 py-3 font-medium whitespace-nowrap">
                  {entry.handle ? `@${entry.handle}` : '—'}{' '}
                  <span className="text-xs text-[var(--color-ink-3)]">{entry.platform ?? ''}</span>
                </td>
                <td className="px-4 py-3">{entry.email}</td>
                <td className="px-4 py-3 text-[var(--color-ink-2)]">{entry.city}</td>
                <td className="px-4 py-3 text-xs text-[var(--color-ink-2)] whitespace-nowrap">
                  {entry.emailVerifiedAt ? 'email ' : ''}
                  {entry.phoneVerifiedAt ? 'phone' : ''}
                  {!entry.verifiedAt && '—'}
                </td>
                <td className="px-4 py-3 tabular">{entry.points}</td>
                <td className="px-4 py-3 tabular">
                  {entry.level} <span className="text-xs text-[var(--color-ink-3)]">({entry.verifiedReferrals} ref)</span>
                </td>
                <td className="px-4 py-3 text-[var(--color-ink-2)]">{entry.ageBracket ?? '—'}</td>
                <td className="px-4 py-3 text-[var(--color-ink-2)]">{entry.followersBracket ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-[var(--color-ink-2)]">{entry.categories.join(', ') || '—'}</td>
                <td className="px-4 py-3 text-xs tabular">{entry.referredBy ?? '—'}</td>
              </tr>
            ))}
            {waitlist.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                  Nobody on the waitlist yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="text-base font-semibold mb-2">Accounts</h2>
      <div className="card overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              <th className="text-left font-semibold px-4 py-3">When</th>
              <th className="text-left font-semibold px-4 py-3">Email</th>
              <th className="text-left font-semibold px-4 py-3">State</th>
              <th className="text-left font-semibold px-4 py-3">City</th>
              <th className="text-left font-semibold px-4 py-3">Referred by</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-[var(--color-line)] last:border-0">
                <td className="px-4 py-3 tabular whitespace-nowrap text-[var(--color-ink-2)]">{when(user.createdAt)}</td>
                <td className="px-4 py-3">{user.email ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className="chip text-xs">{user.state}</span>
                </td>
                <td className="px-4 py-3 text-[var(--color-ink-2)]">{user.city ?? '—'}</td>
                <td className="px-4 py-3 text-xs tabular">{user.referredBy?.referralCode ?? '—'}</td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                  No accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="text-base font-semibold mb-2">Brand enquiries</h2>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              <th className="text-left font-semibold px-4 py-3">When</th>
              <th className="text-left font-semibold px-4 py-3">Company</th>
              <th className="text-left font-semibold px-4 py-3">Contact</th>
              <th className="text-left font-semibold px-4 py-3">Budget</th>
              <th className="text-left font-semibold px-4 py-3">Objective</th>
              <th className="text-left font-semibold px-4 py-3">Message</th>
            </tr>
          </thead>
          <tbody>
            {enquiries.map((enquiry) => (
              <tr key={enquiry.id} className="border-b border-[var(--color-line)] last:border-0 align-top">
                <td className="px-4 py-3 tabular whitespace-nowrap text-[var(--color-ink-2)]">{when(enquiry.createdAt)}</td>
                <td className="px-4 py-3 font-medium">{enquiry.company}</td>
                <td className="px-4 py-3">
                  {enquiry.name}
                  <br />
                  <a href={`mailto:${enquiry.email}`} className="text-xs underline text-[var(--color-ink-2)]">
                    {enquiry.email}
                  </a>
                </td>
                <td className="px-4 py-3 text-[var(--color-ink-2)]">{enquiry.budgetBracket}</td>
                <td className="px-4 py-3 text-[var(--color-ink-2)]">{enquiry.objective ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-[var(--color-ink-2)] max-w-md">{enquiry.message ?? '—'}</td>
              </tr>
            ))}
            {enquiries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                  No brand enquiries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
