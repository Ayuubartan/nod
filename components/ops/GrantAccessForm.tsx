'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsGrantWaitlistAccess } from '@/app/(ops)/actions'

/** "Let the next N in." Verified first, priority levels first, then points. */
export function GrantAccessForm() {
  const router = useRouter()
  const [count, setCount] = useState(25)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function grant() {
    setPending(true)
    setResult(null)
    const res = await opsGrantWaitlistAccess(count)
    setPending(false)
    if (res.ok) {
      setResult(`Granted access to ${res.data?.granted ?? 0} people for 48h.`)
      router.refresh()
    } else setResult(res.error)
  }

  return (
    <div className="card p-4">
      <p className="text-sm font-medium mb-2">Grant access to the next</p>
      <div className="flex gap-2 items-center">
        <input
          type="number"
          min={1}
          max={500}
          className="field w-24"
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
        />
        <button type="button" className="btn btn-primary" disabled={pending || count < 1} onClick={grant}>
          {pending ? 'Granting…' : 'Grant 48h access'}
        </button>
      </div>
      {result && <p className="text-xs text-[var(--color-ink-2)] mt-2">{result}</p>}
      <p className="text-xs text-[var(--color-ink-3)] mt-2">
        Sends the &ldquo;DIN TUR&rdquo; SMS to those who consented and an email to everyone granted. Audited.
      </p>
    </div>
  )
}
