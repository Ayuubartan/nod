'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  opsClearParticipantFlag,
  opsFlagParticipant,
  opsRemoveParticipant,
  opsRestoreParticipant,
  opsSuspendParticipant,
} from '@/app/(ops)/actions'

/** Flag / suspend / restore / remove, all with a mandatory audited reason. */
export function OpsParticipantActions({ userId, state }: { userId: string; state: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setPending(true)
    setError(null)
    const result = await fn()
    setPending(false)
    if (result.ok) {
      setReason('')
      setOpen(false)
      router.refresh()
    } else {
      setError(result.error ?? 'error')
    }
  }

  if (!open) {
    return (
      <button type="button" className="text-xs underline text-[var(--color-ink-2)]" onClick={() => setOpen(true)}>
        Actions
      </button>
    )
  }

  const disabled = pending || reason.trim().length === 0

  return (
    <div className="grid gap-2 min-w-56">
      <input
        className="field text-xs"
        placeholder="Reason (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />

      <div className="flex flex-wrap gap-1">
        {['VERIFIED', 'ACTIVE'].includes(state) && (
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={disabled}
            onClick={() => run(() => opsFlagParticipant(userId, reason))}
          >
            Flag
          </button>
        )}

        {state === 'FLAGGED' && (
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={disabled}
            onClick={() => run(() => opsClearParticipantFlag(userId, reason))}
          >
            Clear
          </button>
        )}

        {['VERIFIED', 'ACTIVE', 'FLAGGED'].includes(state) && (
          <button
            type="button"
            className="btn btn-secondary text-xs text-[var(--color-red)]"
            disabled={disabled}
            onClick={() => run(() => opsSuspendParticipant(userId, reason))}
          >
            Suspend
          </button>
        )}

        {state === 'SUSPENDED' && (
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={disabled}
            onClick={() => run(() => opsRestoreParticipant(userId, reason))}
          >
            Restore
          </button>
        )}

        {state !== 'REMOVED' && (
          <button
            type="button"
            className="btn btn-secondary text-xs text-[var(--color-red)]"
            disabled={disabled}
            onClick={() => run(() => opsRemoveParticipant(userId, reason))}
          >
            Remove
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
