'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsApproveSubmission, opsRejectSubmission, opsReplaySubmissionVerification } from '@/app/(ops)/actions'

const REASONS = ['OPS_REJECTED', 'FRAUD', 'NOT_OWNER', 'NO_DISCLOSURE', 'DELETED_EARLY', 'DUPLICATE', 'OUTSIDE_WINDOW'] as const

/**
 * Ops controls for one clip submission (docs/14 §5). Approve only exists for HELD rows;
 * reject always needs a note. Replay re-runs ownership + disclosure verification.
 * Internal console: English only, like the rest of components/ops.
 */
export function SubmissionActions({ submissionId, state }: { submissionId: string; state: string }) {
  const router = useRouter()
  const [reason, setReason] = useState<(typeof REASONS)[number]>('OPS_REJECTED')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; data?: { outcome: string } }>) => {
    setPending(true)
    setError(null)
    setMessage(null)
    const result = await fn()
    setPending(false)
    if (result.ok) {
      setNote('')
      setMessage(result.data?.outcome ?? 'done')
      router.refresh()
    } else {
      setError(result.error ?? 'error')
    }
  }

  const canReplay = state === 'RECEIVED' || state === 'FIX_DISCLOSURE'

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2 items-center">
        {state === 'HELD' && (
          <button
            type="button"
            className="btn btn-primary text-xs"
            disabled={pending}
            onClick={() => run(() => opsApproveSubmission(submissionId))}
          >
            Approve
          </button>
        )}
        {canReplay && (
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={pending}
            onClick={() => run(() => opsReplaySubmissionVerification(submissionId))}
          >
            Re-verify
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="field text-xs"
          value={reason}
          onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}
          aria-label="Reject reason"
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input
          className="field text-xs flex-1 min-w-40"
          placeholder="Note (required)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-danger text-xs"
          disabled={pending || note.trim().length < 3}
          onClick={() => run(() => opsRejectSubmission({ submissionId, reason, note }))}
        >
          Reject
        </button>
      </div>

      {error && <p className="text-xs text-[var(--color-red)]">{error}</p>}
      {message && <p className="text-xs text-[var(--color-ink-2)]">{message}</p>}
    </div>
  )
}
