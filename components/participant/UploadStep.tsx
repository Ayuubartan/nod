'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { EVENTS, track } from '@/lib/analytics'

/**
 * P-02 upload — docs/02 A3.
 *
 * Compresses on the client before uploading, because the pilot audience is on 4G and a
 * 12 MB phone photo is a 30-second upload. The hash and storage are done server-side by
 * /api/upload, so the duplicate check cannot be spoofed by the client.
 */
const MAX_DIMENSION = 1440
const JPEG_QUALITY = 0.82

async function compress(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file

  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size < 2 * 1024 * 1024) return file

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)

  const context = canvas.getContext('2d')
  if (!context) return file
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob ?? file), 'image/jpeg', JPEG_QUALITY),
  )
}

export function UploadStep({ placementId }: { placementId: string }) {
  const t = useTranslations('placement.upload')
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [preview, setPreview] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onFile(file: File) {
    setPending(true)
    setError(null)
    setPreview(URL.createObjectURL(file))

    try {
      const blob = await compress(file)
      const form = new FormData()
      form.append('file', blob, file.name)
      form.append('placementId', placementId)
      form.append('contentType', 'story')

      const response = await fetch('/api/upload', { method: 'POST', body: form })
      const result = (await response.json()) as { ok: boolean; error?: string }

      if (!result.ok) {
        setError(result.error ?? 'format')
        setPending(false)
        return
      }

      track(EVENTS.uploadCompleted, { placement_id: placementId })
      router.refresh()
    } catch {
      setError('format')
      setPending(false)
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg mb-1">{t('title')}</h2>
      <p className="text-sm text-[var(--color-ink-2)] mb-4">{t('sub')}</p>

      {preview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="w-full rounded-lg mb-4 max-h-80 object-contain bg-[var(--color-bg)]" />
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void onFile(file)
        }}
      />

      <button
        type="button"
        className="btn btn-primary w-full"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
      >
        {pending ? t('checking') : t('choose')}
      </button>

      {error && (
        <p className="error-text" role="alert">
          {t(`errors.${error}` as never)}
        </p>
      )}
    </section>
  )
}
