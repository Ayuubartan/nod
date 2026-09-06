import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'

/**
 * Audit log viewer — docs/02 section C.
 *
 * Every state transition in the product writes a row here (CLAUDE.md rule 1), so this
 * page is the single place to answer "what happened to this placement, and who did it".
 */
export const dynamic = 'force-dynamic'

export default async function OpsAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; entityId?: string; actor?: string; page?: string }>
}) {
  await requireOps()
  const { entity, entityId, actor, page } = await searchParams

  const pageNumber = Math.max(1, Number(page ?? 1) || 1)
  const perPage = 100

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        ...(entity ? { entity } : {}),
        ...(entityId ? { entityId } : {}),
        ...(actor ? { actor: { contains: actor } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (pageNumber - 1) * perPage,
      take: perPage,
    }),
    prisma.auditLog.count({
      where: {
        ...(entity ? { entity } : {}),
        ...(entityId ? { entityId } : {}),
        ...(actor ? { actor: { contains: actor } } : {}),
      },
    }),
  ])

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl">Audit log</h1>
        <p className="text-sm text-[var(--color-ink-2)] tabular">{total.toLocaleString('sv-SE')} entries</p>
      </div>

      <form className="flex flex-wrap gap-2 mb-4" action="/ops/audit">
        <select name="entity" defaultValue={entity ?? ''} className="field max-w-40">
          <option value="">All entities</option>
          {['Placement', 'Campaign', 'Participant', 'Brand', 'Wallet', 'PayoutBatch', 'Flag', 'SocialAccount', 'Referral'].map(
            (name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ),
          )}
        </select>
        <input name="entityId" defaultValue={entityId ?? ''} placeholder="entity id" className="field max-w-56" />
        <input name="actor" defaultValue={actor ?? ''} placeholder="actor" className="field max-w-40" />
        <button type="submit" className="btn btn-secondary text-sm">
          Filter
        </button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              <th className="text-left font-semibold px-3 py-2">When</th>
              <th className="text-left font-semibold px-3 py-2">Entity</th>
              <th className="text-left font-semibold px-3 py-2">Id</th>
              <th className="text-left font-semibold px-3 py-2">Event</th>
              <th className="text-left font-semibold px-3 py-2">From → To</th>
              <th className="text-left font-semibold px-3 py-2">Actor</th>
              <th className="text-left font-semibold px-3 py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-[var(--color-line)] last:border-0">
                <td className="px-3 py-2 tabular whitespace-nowrap text-[var(--color-ink-2)]">
                  {entry.createdAt.toLocaleString('sv-SE')}
                </td>
                <td className="px-3 py-2">{entry.entity}</td>
                <td className="px-3 py-2 tabular text-[var(--color-ink-3)]">{entry.entityId.slice(0, 10)}</td>
                <td className="px-3 py-2 font-medium">{entry.event}</td>
                <td className="px-3 py-2 text-[var(--color-ink-2)]">
                  {entry.fromState ?? '—'} → {entry.toState ?? '—'}
                </td>
                <td className="px-3 py-2 tabular">{entry.actor}</td>
                <td className="px-3 py-2 text-[var(--color-ink-2)] max-w-64 truncate">{entry.reason ?? '—'}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-ink-3)]">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {total > perPage && (
        <nav className="flex gap-2 mt-4 text-sm">
          {pageNumber > 1 && (
            <a href={`?page=${pageNumber - 1}`} className="btn btn-secondary text-sm">
              Previous
            </a>
          )}
          {pageNumber * perPage < total && (
            <a href={`?page=${pageNumber + 1}`} className="btn btn-secondary text-sm">
              Next
            </a>
          )}
        </nav>
      )}
    </div>
  )
}
