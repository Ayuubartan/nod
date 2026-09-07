'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsFailGeneration, opsRunEngine, opsUploadGeneratedVersion } from '@/app/(ops)/actions'

/** Run the engine, upload a hand-made result, or mark the job failed so it retries. */
export function GenerationCard({ placementId }: { placementId: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [pending, setPending] = useState(false)
  const [failing, setFailing] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onUpload(file: File) {
    setPending(true)
    setError(null)

    const form = new FormData()
    form.append('placementId', placementId)
    form.append('file', file)

    const result = await opsUploadGeneratedVersion(form)
    setPending(false)
    if (result.ok) router.refresh()
    else setError(result.error)
  }

  return (
    <div className="grid gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void onUpload(file)
        }}
      />

      <button
        type="button"
        className="btn btn-primary text-sm w-full"
        disabled={pending}
        onClick={async () => {
          setPending(true)
          setError(null)
          const result = await opsRunEngine(placementId)
          setPending(false)
          if (result.ok) router.refresh()
          else setError(result.error)
        }}
      >
        {pending ? 'Working…' : 'Run engine'}
      </button>

      <button
        type="button"
        className="btn btn-secondary text-sm w-full"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >
        Upload result by hand
      </button>

      {failing ? (
        <div className="grid gap-2">
          <input
            className="field text-sm"
            placeholder="Why did it fail?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary text-sm text-[var(--color-red)]"
            disabled={pending || reason.trim().length === 0}
            onClick={async () => {
              setPending(true)
              await opsFailGeneration(placementId, reason)
              setPending(false)
              router.refresh()
            }}
          >
            Mark failed
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary text-xs" onClick={() => setFailing(true)}>
          Mark failed
        </button>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
