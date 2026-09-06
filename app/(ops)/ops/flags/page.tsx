import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { FLAG_DEFAULTS } from '@/lib/flags'
import { FlagEditor } from '@/components/ops/FlagEditor'

/**
 * Feature flags and pricing floors — docs/02 section C, docs/05:
 * "Floors and defaults are Flags, editable by ops without deploy."
 */
export const dynamic = 'force-dynamic'

export default async function OpsFlagsPage() {
  await requireOps()

  const rows = await prisma.flag.findMany()
  const stored = new Map(rows.map((row) => [row.key, row.value]))

  const flags = (Object.keys(FLAG_DEFAULTS) as Array<keyof typeof FLAG_DEFAULTS>).map((key) => ({
    key,
    value: stored.has(key) ? stored.get(key) : FLAG_DEFAULTS[key],
    defaultValue: FLAG_DEFAULTS[key],
    overridden: stored.has(key),
  }))

  const groups = new Map<string, typeof flags>()
  for (const item of flags) {
    const group = item.key.split('.')[0] ?? 'other'
    groups.set(group, [...(groups.get(group) ?? []), item])
  }

  return (
    <div>
      <h1 className="text-xl mb-1">Flags</h1>
      <p className="text-sm text-[var(--color-ink-2)] mb-6">
        A missing or malformed value always falls back to the compile-time default, so a bad
        edit here cannot take the product down.
      </p>

      <div className="grid gap-6">
        {[...groups.entries()].map(([group, items]) => (
          <section key={group}>
            <h2 className="label">{group}</h2>
            <div className="card divide-y divide-[var(--color-line)]">
              {items.map((item) => (
                <FlagEditor
                  key={item.key}
                  flagKey={item.key}
                  value={item.value}
                  defaultValue={item.defaultValue}
                  overridden={item.overridden}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
