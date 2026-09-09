'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { disconnectAccount, syncAccountNow } from '@/app/(participant)/actions'

/** "Update now" and "Disconnect" on an account card (docs/02 A6). */
export function AccountActions({
  accountId,
  canSync,
  labels,
  errors,
}: {
  accountId: string
  canSync: boolean
  labels: { sync: string; syncing: string; disconnect: string; disconnecting: string }
  errors: Record<string, string>
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<'sync' | 'disconnect' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSync() {
    setBusy('sync')
    setError(null)
    const result = await syncAccountNow(accountId)
    setBusy(null)
    if (!result.ok) setError(errors[result.error] ?? result.error)
    router.refresh()
  }

  async function onDisconnect() {
    setBusy('disconnect')
    setError(null)
    const result = await disconnectAccount(accountId)
    setBusy(null)
    if (!result.ok) setError(errors[result.error] ?? result.error)
    router.refresh()
  }

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        {canSync && (
          <button type="button" className="btn btn-secondary flex-1 text-sm min-h-10 py-2" onClick={onSync} disabled={busy !== null}>
            {busy === 'sync' ? labels.syncing : labels.sync}
          </button>
        )}
        <button
          type="button"
          className="btn flex-1 text-sm min-h-10 py-2 text-[var(--color-ink-3)] hover:text-[var(--color-red)]"
          onClick={onDisconnect}
          disabled={busy !== null}
        >
          {busy === 'disconnect' ? labels.disconnecting : labels.disconnect}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
