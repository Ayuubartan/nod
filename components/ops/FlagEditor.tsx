'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsSetFlag } from '@/app/(ops)/actions'

/**
 * One flag row. The editor is typed off the default's runtime type, so a boolean flag
 * gets a checkbox and a number flag a number input — ops cannot accidentally store a
 * string where the code expects a number.
 */
export function FlagEditor({
  flagKey,
  value,
  defaultValue,
  overridden,
}: {
  flagKey: string
  value: unknown
  defaultValue: unknown
  overridden: boolean
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(() =>
    typeof defaultValue === 'object' ? JSON.stringify(value) : String(value),
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const kind = typeof defaultValue === 'boolean' ? 'boolean' : typeof defaultValue === 'number' ? 'number' : 'json'

  async function save(next: unknown) {
    setPending(true)
    setError(null)
    const result = await opsSetFlag(flagKey, next)
    setPending(false)
    if (result.ok) router.refresh()
    else setError(result.error)
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <code className="text-xs flex-1 min-w-56">{flagKey}</code>

      {kind === 'boolean' ? (
        <input
          type="checkbox"
          className="size-4 accent-[var(--color-orange)]"
          checked={value === true}
          disabled={pending}
          onChange={(e) => void save(e.target.checked)}
        />
      ) : (
        <>
          <input
            className="field text-sm max-w-56 tabular"
            type={kind === 'number' ? 'number' : 'text'}
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={pending}
            onClick={() => {
              if (kind === 'number') return void save(Number(draft))
              try {
                return void save(JSON.parse(draft))
              } catch {
                setError('Invalid JSON')
              }
            }}
          >
            Save
          </button>
        </>
      )}

      <span className="text-xs text-[var(--color-ink-3)] w-28 text-right">
        {overridden ? `default ${String(kind === 'json' ? JSON.stringify(defaultValue) : defaultValue)}` : 'default'}
      </span>

      {error && <p className="error-text w-full">{error}</p>}
    </div>
  )
}
