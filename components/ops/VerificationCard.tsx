'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsUploadScreenshot, opsVerifyFromScreenshot } from '@/app/(ops)/actions'

/**
 * Screenshot-tier verification. Ops pastes the caption and the view count from the
 * screenshot; the same pipeline that handles API-tier placements then runs checks 1–6.
 *
 * There is deliberately no control here to pass a placement whose caption lacks the
 * disclosure — check 2 is a payable condition with no override (CLAUDE.md rule 5).
 */
export function VerificationCard({
  placementId,
  handle,
  tier,
  campaignLabel,
  postUrl,
  expectedDisclosure,
  avgViews30d,
  screenshotUrl,
}: {
  placementId: string
  handle: string
  tier: string
  campaignLabel: string
  postUrl: string | null
  expectedDisclosure: string
  avgViews30d: number
  screenshotUrl: string | null
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [views, setViews] = useState('')
  const [caption, setCaption] = useState('')
  const [label, setLabel] = useState(false)
  const [stillLive, setStillLive] = useState(true)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit() {
    setPending(true)
    setError(null)

    const result = await opsVerifyFromScreenshot({
      placementId,
      views: Number(views),
      caption,
      hasPaidPartnershipLabel: label,
      stillLive,
    })

    setPending(false)
    if (result.ok && result.data) {
      setOutcome(result.data.decision)
      router.refresh()
    } else if (!result.ok) {
      setError(result.error)
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="font-semibold text-sm">@{handle}</p>
          <p className="text-xs text-[var(--color-ink-3)]">{campaignLabel}</p>
        </div>
        <span className="chip text-xs">{tier}</span>
      </div>

      <p className="text-xs text-[var(--color-ink-3)] mb-1">Expected disclosure</p>
      <p className="text-xs card px-2 py-1 mb-3 bg-[var(--color-bg)]">{expectedDisclosure}</p>

      {postUrl && (
        <a
          href={postUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="btn btn-secondary text-xs w-full mb-3"
        >
          Open the post ↗
        </a>
      )}

      {screenshotUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={screenshotUrl} alt="" className="w-full rounded mb-3 max-h-48 object-contain bg-[var(--color-bg)]" />
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          const form = new FormData()
          form.append('placementId', placementId)
          form.append('file', file)
          setPending(true)
          await opsUploadScreenshot(form)
          setPending(false)
          router.refresh()
        }}
      />
      <button
        type="button"
        className="btn btn-secondary text-xs w-full mb-3"
        onClick={() => inputRef.current?.click()}
      >
        Upload screenshot
      </button>

      <div className="grid gap-2">
        <div>
          <label className="label" htmlFor={`caption-${placementId}`}>
            Caption as published
          </label>
          <textarea
            id={`caption-${placementId}`}
            rows={3}
            className="field text-sm"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor={`views-${placementId}`}>
            Views (baseline {avgViews30d.toLocaleString('sv-SE')})
          </label>
          <input
            id={`views-${placementId}`}
            type="number"
            min={0}
            className="field text-sm tabular"
            value={views}
            onChange={(e) => setViews(e.target.value)}
          />
        </div>

        <label className="flex gap-2 items-center text-xs">
          <input
            type="checkbox"
            checked={label}
            onChange={(e) => setLabel(e.target.checked)}
            className="size-4 accent-[var(--color-amber)]"
          />
          Paid partnership label on
        </label>

        <label className="flex gap-2 items-center text-xs">
          <input
            type="checkbox"
            checked={stillLive}
            onChange={(e) => setStillLive(e.target.checked)}
            className="size-4 accent-[var(--color-amber)]"
          />
          Post is still live
        </label>

        <button
          type="button"
          className="btn btn-primary text-sm w-full"
          disabled={pending || views === '' || caption.trim().length === 0}
          onClick={onSubmit}
        >
          Verify
        </button>
      </div>

      {outcome && (
        <p
          className="text-sm mt-2 font-semibold"
          style={{ color: outcome === 'QUALIFIED' ? 'var(--color-green)' : 'var(--color-red)' }}
        >
          {outcome}
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
