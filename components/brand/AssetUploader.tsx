'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { uploadCampaignAsset } from '@/app/(brand)/actions'

const PLACEMENT_TYPES = ['product', 'logo', 'packaging', 'signage'] as const

/** Upload one product or logo, tagged with where it may be placed (docs/02 B1 step 3). */
export function AssetUploader({ campaignId }: { campaignId: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [types, setTypes] = useState<string[]>(['product'])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (type: string) =>
    setTypes((current) => (current.includes(type) ? current.filter((t) => t !== type) : [...current, type]))

  return (
    <div className="card p-4 grid gap-3">
      <div>
        <label className="label" htmlFor="asset-name">
          Name
        </label>
        <input
          id="asset-name"
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Coffee bag 500g"
        />
      </div>

      <fieldset>
        <legend className="label">Allowed placement types</legend>
        <div className="flex flex-wrap gap-2">
          {PLACEMENT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="chip"
              aria-pressed={types.includes(type)}
              onClick={() => toggle(type)}
            >
              {type}
            </button>
          ))}
        </div>
      </fieldset>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return

          setPending(true)
          setError(null)

          const form = new FormData()
          form.append('campaignId', campaignId)
          form.append('name', name || file.name)
          form.append('placementTypes', types.join(','))
          form.append('file', file)

          const result = await uploadCampaignAsset(form)
          setPending(false)

          if (result.ok) {
            setName('')
            router.refresh()
          } else {
            setError(result.error)
          }
        }}
      />

      <button
        type="button"
        className="btn text-white"
        style={{ background: 'var(--color-blue)' }}
        disabled={pending || types.length === 0}
        onClick={() => inputRef.current?.click()}
      >
        {pending ? 'Uploading…' : 'Upload asset'}
      </button>

      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
