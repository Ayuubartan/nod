'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { connectAccount } from '@/app/(participant)/actions'

type Platform = 'INSTAGRAM' | 'TIKTOK'

const START_PATH: Record<Platform, string> = {
  INSTAGRAM: '/api/auth/instagram/start',
  TIKTOK: '/api/auth/tiktok/start',
}

/**
 * Starts the read-only OAuth flow for one platform. With a developer app configured
 * this is a plain link to `/api/auth/<platform>/start`; with the fake provider (local
 * dev and tests) there is no redirect — the handle typed here is exchanged directly, so
 * onboarding is walkable without Meta or TikTok credentials.
 */
export function ConnectAccountButton({
  platform,
  oauth,
  label,
  placeholder = '@handle',
  returnTo = '/accounts',
  className = 'btn btn-primary w-full',
  onConnected,
  onError,
}: {
  platform: Platform
  /** True when the real provider is configured — render a link, not the fake prompt. */
  oauth: boolean
  label: string
  placeholder?: string
  returnTo?: '/accounts' | '/onboarding'
  className?: string
  onConnected?: (result: { tier: string; handle: string }) => void
  onError?: (error: string) => void
}) {
  const router = useRouter()
  const [handle, setHandle] = useState('')
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)

  if (oauth) {
    return (
      <a className={className} href={`${START_PATH[platform]}?returnTo=${encodeURIComponent(returnTo)}`}>
        {label}
      </a>
    )
  }

  async function onConnect() {
    setPending(true)
    const clean = handle.replace(/^@/, '') || 'testuser'
    const result = await connectAccount(clean, platform)
    setPending(false)
    if (result.ok) {
      setOpen(false)
      onConnected?.({ tier: result.data?.tier ?? 'CONNECTED_SCREENSHOT', handle: clean })
      router.refresh()
    } else {
      onError?.(result.error)
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
        placeholder={placeholder}
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
