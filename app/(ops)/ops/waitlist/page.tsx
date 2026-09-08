import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { FLAG_DEFAULTS, flags } from '@/lib/flags'
import { LEVELS, MAX_REFERRALS_PER_IP } from '@/lib/queue'
import { FlagEditor } from '@/components/ops/FlagEditor'
import { GrantAccessForm } from '@/components/ops/GrantAccessForm'

/**
 * The queue from the inside (docs/13). Plain counts, the level ladder, who leads on
 * points, which networks look like one person inviting themselves, and the four
 * switches that run the game. "Grant access" is the only thing here that changes
 * anyone's state, and it is audited.
 */
export const dynamic = 'force-dynamic'

export default async function OpsWaitlistPage() {
  await requireOps()

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const [total, verified, phoneVerified, smsOn, granted, converted, week, levelRows, top, byIp, settings] =
    await Promise.all([
      prisma.waitlistEntry.count({ where: { deletedAt: null } }),
      prisma.waitlistEntry.count({ where: { deletedAt: null, verifiedAt: { not: null } } }),
      prisma.waitlistEntry.count({ where: { deletedAt: null, phoneVerifiedAt: { not: null } } }),
      prisma.waitlistEntry.count({ where: { deletedAt: null, smsConsentAt: { not: null }, smsOptOutAt: null } }),
      prisma.waitlistEntry.count({ where: { deletedAt: null, accessGrantedAt: { not: null } } }),
      prisma.waitlistEntry.count({ where: { deletedAt: null, convertedUserId: { not: null } } }),
      prisma.waitlistEntry.count({ where: { deletedAt: null, createdAt: { gte: since } } }),
      prisma.waitlistEntry.groupBy({ by: ['level'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.waitlistEntry.findMany({
        where: { deletedAt: null },
        orderBy: [{ points: 'desc' }, { createdAt: 'asc' }],
        take: 20,
        select: {
          id: true,
          email: true,
          city: true,
          points: true,
          level: true,
          verifiedReferrals: true,
          verifiedAt: true,
          priorityAt: true,
          accessGrantedAt: true,
          convertedUserId: true,
        },
      }),
      prisma.waitlistEntry.groupBy({
        by: ['ipHash'],
        where: { deletedAt: null, ipHash: { not: null }, referredBy: { not: null } },
        _count: { _all: true },
        having: { ipHash: { _count: { gte: 3 } } },
        orderBy: { _count: { ipHash: 'desc' } },
        take: 20,
      }),
      flags('waitlist.smsEnabled', 'waitlist.gate', 'waitlist.boostMultiplier', 'waitlist.dailyBoostCount'),
    ])

  const levelCount = new Map(levelRows.map((row) => [row.level, row._count._all]))
  const totals = [
    { label: 'In queue', value: total, note: `+${week} last 7 days` },
    { label: 'Verified', value: verified, note: `${phoneVerified} by phone` },
    { label: 'SMS on', value: smsOn, note: 'consented, not opted out' },
    { label: 'Access granted', value: granted, note: `${converted} opened an account` },
  ]

  const flagRows = (
    ['waitlist.gate', 'waitlist.smsEnabled', 'waitlist.boostMultiplier', 'waitlist.dailyBoostCount'] as const
  ).map((key) => ({ key, value: settings[key] }))

  return (
    <div>
      <h1 className="text-xl mb-1">Waitlist</h1>
      <p className="text-sm text-[var(--color-ink-2)] mb-6">
        Every number here comes from the ledger and the event table. Nothing is inflated.
      </p>

      <ul className="grid gap-3 sm:grid-cols-4 mb-8">
        {totals.map((item) => (
          <li key={item.label} className="card p-4">
            <p className="text-xs text-[var(--color-ink-2)] mb-1">{item.label}</p>
            <p className="amount text-3xl font-bold">{item.value}</p>
            <p className="text-xs text-[var(--color-ink-3)] mt-1">{item.note}</p>
          </li>
        ))}
      </ul>

      <div className="grid gap-6 lg:grid-cols-2 mb-8">
        <section>
          <h2 className="label">Levels</h2>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {LEVELS.map((level) => (
                  <tr key={level.key} className="border-b border-[var(--color-line)] last:border-0">
                    <td className="px-4 py-2 tabular">{level.level}</td>
                    <td className="px-4 py-2">
                      {level.key}
                      {level.priority && <span className="text-xs text-[var(--color-ink-3)]"> · priority</span>}
                    </td>
                    <td className="px-4 py-2 text-[var(--color-ink-2)] tabular">{level.referrals} verified referrals</td>
                    <td className="px-4 py-2 text-right tabular font-medium">{levelCount.get(level.level) ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="label">Switches</h2>
          <div className="card divide-y divide-[var(--color-line)] mb-3">
            {flagRows.map((row) => (
              <FlagEditor
                key={row.key}
                flagKey={row.key}
                value={row.value}
                defaultValue={FLAG_DEFAULTS[row.key]}
                overridden={row.value !== FLAG_DEFAULTS[row.key]}
              />
            ))}
          </div>
          <p className="text-xs text-[var(--color-ink-3)] mb-4">
            gate: only people with access may open an account · smsEnabled: verification codes and digests go out ·
            boostMultiplier: referral points × N (announce it, then set it) · dailyBoostCount: random verified
            people given +500 each day, 0 = off.
          </p>
          <GrantAccessForm />
        </section>
      </div>

      <h2 className="text-base font-semibold mb-2">Top 20 by points</h2>
      <div className="card overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              <th className="text-left font-semibold px-4 py-3">Email</th>
              <th className="text-left font-semibold px-4 py-3">City</th>
              <th className="text-left font-semibold px-4 py-3">Points</th>
              <th className="text-left font-semibold px-4 py-3">Level</th>
              <th className="text-left font-semibold px-4 py-3">Referrals</th>
              <th className="text-left font-semibold px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {top.map((entry) => (
              <tr key={entry.id} className="border-b border-[var(--color-line)] last:border-0">
                <td className="px-4 py-3">{entry.email}</td>
                <td className="px-4 py-3 text-[var(--color-ink-2)]">{entry.city}</td>
                <td className="px-4 py-3 tabular">{entry.points}</td>
                <td className="px-4 py-3 tabular">{entry.level}</td>
                <td className="px-4 py-3 tabular">{entry.verifiedReferrals}</td>
                <td className="px-4 py-3 text-xs text-[var(--color-ink-2)]">
                  {entry.convertedUserId
                    ? 'account'
                    : entry.accessGrantedAt
                      ? 'access'
                      : entry.priorityAt
                        ? 'priority'
                        : entry.verifiedAt
                          ? 'verified'
                          : 'unverified'}
                </td>
              </tr>
            ))}
            {top.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                  Nobody in the queue yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="text-base font-semibold mb-2">Networks to look at</h2>
      <p className="text-xs text-[var(--color-ink-3)] mb-2">
        IP hashes with three or more referred signups. Referrals stop counting after {MAX_REFERRALS_PER_IP} verified
        from the same hash; the rows are here so a human can look before anyone is removed.
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              <th className="text-left font-semibold px-4 py-3">IP hash</th>
              <th className="text-left font-semibold px-4 py-3">Referred signups</th>
            </tr>
          </thead>
          <tbody>
            {byIp.map((row) => (
              <tr key={row.ipHash} className="border-b border-[var(--color-line)] last:border-0">
                <td className="px-4 py-3 tabular text-xs">{row.ipHash}</td>
                <td className="px-4 py-3 tabular">{row._count._all}</td>
              </tr>
            ))}
            {byIp.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                  Nothing suspicious.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
