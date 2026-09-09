import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { formatOre } from '@/lib/money/calc'
import { walletBalance } from '@/lib/money/balances'
import { OpsParticipantActions } from '@/components/ops/OpsParticipantActions'

/** Participants — docs/02 section C: search, state, strikes, accounts, tier. */
export const dynamic = 'force-dynamic'

export default async function OpsParticipantsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string }>
}) {
  await requireOps()
  const { q, state } = await searchParams

  const users = await prisma.user.findMany({
    where: {
      role: 'PARTICIPANT',
      ...(state ? { state: state as never } : {}),
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { city: { contains: q, mode: 'insensitive' } },
              { referralCode: { equals: q.toUpperCase() } },
              { accounts: { some: { handle: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    },
    include: {
      accounts: { where: { deletedAt: null } },
      strikes: { where: { deletedAt: null } },
      wallet: { select: { id: true } },
      _count: { select: { placements: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  const balances = new Map<string, number>()
  for (const user of users) {
    if (!user.wallet) continue
    balances.set(user.id, (await walletBalance(prisma, user.wallet.id)).availableOre)
  }

  const states = ['SIGNED_UP', 'ONBOARDED', 'VERIFIED', 'ACTIVE', 'FLAGGED', 'SUSPENDED', 'REMOVED']

  return (
    <div>
      <h1 className="text-xl mb-4">Participants</h1>

      <form className="flex flex-wrap gap-2 mb-4" action="/ops/participants">
        <input name="q" defaultValue={q ?? ''} placeholder="handle, email, city, code" className="field max-w-xs" />
        <select name="state" defaultValue={state ?? ''} className="field max-w-40">
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-secondary text-sm">
          Search
        </button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              <th className="text-left font-semibold px-4 py-3">Accounts</th>
              <th className="text-left font-semibold px-4 py-3">State</th>
              <th className="text-left font-semibold px-4 py-3">City</th>
              <th className="text-right font-semibold px-4 py-3">Placements</th>
              <th className="text-right font-semibold px-4 py-3">Strikes</th>
              <th className="text-right font-semibold px-4 py-3">Wallet</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-[var(--color-line)] last:border-0 align-top">
                <td className="px-4 py-3">
                  <ul className="grid gap-1">
                    {user.accounts.map((account) => (
                      <li key={account.id} className="text-xs">
                        <span className="font-medium">@{account.handle}</span>{' '}
                        <span className="text-[var(--color-ink-3)]">
                          {account.platform === 'TIKTOK' ? 'TikTok' : 'Instagram'} · {account.tier} ·{' '}
                          {account.followers.toLocaleString('sv-SE')} · {account.avgViews30d.toLocaleString('sv-SE')}
                          {account.lastSyncedAt && ` · ${account.lastSyncedAt.toLocaleDateString('sv-SE')}`}
                        </span>
                      </li>
                    ))}
                    {user.accounts.length === 0 && <li className="text-xs text-[var(--color-ink-3)]">—</li>}
                  </ul>
                </td>
                <td className="px-4 py-3">
                  <span className="chip text-xs">{user.state}</span>
                </td>
                <td className="px-4 py-3 text-[var(--color-ink-2)]">{user.city ?? '—'}</td>
                <td className="px-4 py-3 text-right tabular">{user._count.placements}</td>
                <td className="px-4 py-3 text-right tabular">
                  {user.strikes.filter((s) => s.severity === 'SERIOUS').length}S/
                  {user.strikes.filter((s) => s.severity === 'MINOR').length}M
                </td>
                <td className="px-4 py-3 text-right tabular">{formatOre(balances.get(user.id) ?? 0)}</td>
                <td className="px-4 py-3">
                  <OpsParticipantActions userId={user.id} state={user.state} />
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                  No participants match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
