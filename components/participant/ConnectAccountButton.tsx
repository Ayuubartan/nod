'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { connectAccount } from '@/app/(participant)/actions'

/**
 * Starts the Instagram OAuth flow. With the fake provider (local dev and tests) there
 * is no redirect: the handle typed here is exchanged directly, so onboarding is
 * walkable without Meta credentials.
 */
export function ConnectAccountButton({ label, className }: { label: string; className?: string }) {
  const router = useRouter()
  const [handle, setHandle] = useState('')
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)

  async function onConnect() {
    setPending(true)
    const result = await connectAccount(handle.replace(/^@/, '') || 'testuser')
    setPending(false)
    if (result.ok) {
      setOpen(false)
      router.refresh()
    }
  }

  if (!open) {
    return (
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  }

  return (
    <div className="grid gap-2">
      <input
        className="field"
        placeholder="@handle"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        autoFocus
      />
      <button type="button" className={className} onClick={onConnect} disabled={pending}>
        {label}
      </button>
    </div>
  )
}
