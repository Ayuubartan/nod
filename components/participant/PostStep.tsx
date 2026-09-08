'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { submitPostUrl } from '@/app/(participant)/actions'
import { EVENTS, track } from '@/lib/analytics'
import { mediaUrl } from '@/lib/media-url'

/**
 * P-07 ready to post — docs/02 A3.
 *
 * The checklist is not decoration: disclosure is a payable condition, and this is the
 * last screen before the participant publishes. The Submit button stays disabled until
 * all three boxes are ticked, so nobody posts without reading them.
 */
export function PostStep({
  placementId,
  disclosure,
  handle,
  mediaPath,
  autoDetect,
}: {
  placementId: string
  disclosure: string
  handle: string
  mediaPath: string | null
  autoDetect: boolean
}) {
  const t = useTranslations('placement.approved')
  const common = useTranslations('common')
  const router = useRouter()

  const [checks, setChecks] = useState([false, false, false])
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allChecked = checks.every(Boolean)

  const toggle = (index: number) =>
    setChecks((current) => current.map((value, i) => (i === index ? !value : value)))

  async function onSubmit() {
    setPending(true)
    setError(null)
    const result = await submitPostUrl(placementId, url.trim())
    setPending(false)

    if (result.ok) {
      track(EVENTS.postUrlSubmitted, { placement_id: placementId })
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-lg mb-4">{t('title')}</h2>

      {mediaPath && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mediaUrl(mediaPath)} alt="" className="w-full rounded-lg mb-3 max-h-96 object-contain bg-[var(--color-bg)]" />
          <a href={mediaUrl(mediaPath)} download className="btn btn-secondary w-full mb-5">
            {t('download')}
          </a>
        </>
      )}

      <div className="mb-5">
        <h3 className="label">{t('disclosure')}</h3>
        <p className="card px-3 py-2 text-sm mb-2">{disclosure}</p>
        <button
          type="button"
          className="btn btn-secondary w-full text-sm"
          onClick={() => {
            void navigator.clipboard.writeText(disclosure)
            setCopied(true)
          }}
        >
          {copied ? common('copied') : common('copy')}
        </button>
        <p className="text-xs text-[var(--color-ink-3)] mt-2">{t('disclosureHint')}</p>
      </div>

      <fieldset className="mb-5">
        <legend className="label">{t('checklist')}</legend>
        <ul className="grid gap-2">
          {[t('check1'), t('check2'), t('check3', { handle: `@${handle}` })].map((label, index) => (
            <li key={label}>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={checks[index]}
                  onChange={() => toggle(index)}
                  className="mt-0.5 size-4 accent-[var(--color-orange)]"
                />
                <span>{label}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div>
        <label className="label" htmlFor="post-url">
          {t('submitUrl')}
        </label>
        {autoDetect && <p className="text-xs text-[var(--color-ink-3)] mb-2">{t('autoDetect')}</p>}
        <input
          id="post-url"
          type="url"
          inputMode="url"
          className="field mb-3"
          placeholder="https://instagram.com/p/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />

        {error && (
          <p className="error-text mb-2" role="alert">
            {error === 'invalidUrl' ? t('invalidUrl', { handle: `@${handle}` }) : error}
          </p>
        )}

        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={pending || !allChecked || url.trim().length === 0}
          onClick={onSubmit}
        >
          {t('submit')}
        </button>
      </div>
    </section>
  )
}
