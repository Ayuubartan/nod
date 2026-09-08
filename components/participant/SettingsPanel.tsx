'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  cancelDeletion,
  exportMyData,
  requestDeletion,
  setTrainingConsent,
} from '@/app/(participant)/actions'
import { SwishForm } from './SwishForm'

export function SettingsPanel({
  trainingConsent,
  maskedSwish,
  deletionRequestedAt,
  locale,
}: {
  trainingConsent: boolean
  maskedSwish: string | null
  deletionRequestedAt: string | null
  locale: 'sv' | 'en'
}) {
  const t = useTranslations('settings')
  const common = useTranslations('common')
  const training = useTranslations('onboarding.training')
  const router = useRouter()

  const [consent, setConsent] = useState(trainingConsent)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, setPending] = useState(false)

  async function onExport() {
    setPending(true)
    const result = await exportMyData()
    setPending(false)
    if (!result.ok || !result.data) return

    // Delivered as a direct download rather than an email link: it is the participant's
    // own data and they are already authenticated.
    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `nod-data-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="grid gap-4">
      <section className="card p-4">
        <h2 className="label">{t('trainingConsent')}</h2>
        <label className="flex gap-3 items-start text-sm">
          <input
            type="checkbox"
            checked={consent}
            className="mt-1 size-4 accent-[var(--color-orange)]"
            onChange={async (e) => {
              const next = e.target.checked
              setConsent(next)
              await setTrainingConsent(next)
            }}
          />
          <span className="text-[var(--color-ink-2)]">{training('consent')}</span>
        </label>
      </section>

      <section className="card p-4">
        <h2 className="label">{t('payout')}</h2>
        <SwishForm maskedSwish={maskedSwish} />
      </section>

      <section className="card p-4">
        <h2 className="label">{t('downloadData')}</h2>
        <p className="text-xs text-[var(--color-ink-3)] mb-3">{t('downloadDataHint')}</p>
        <button type="button" className="btn btn-secondary w-full text-sm" onClick={onExport} disabled={pending}>
          {t('downloadData')}
        </button>
      </section>

      <section className="card p-4">
        <h2 className="label">{t('deleteAccount')}</h2>
        <p className="text-xs text-[var(--color-ink-3)] mb-3">{t('deleteAccountHint')}</p>

        {deletionRequestedAt ? (
          <>
            <p className="text-sm text-[var(--color-red)] mb-3">{t('deleteRequested')}</p>
            <button
              type="button"
              className="btn btn-secondary w-full text-sm"
              onClick={async () => {
                await cancelDeletion()
                router.refresh()
              }}
            >
              {common('cancel')}
            </button>
          </>
        ) : confirmDelete ? (
          <button
            type="button"
            className="btn btn-secondary w-full text-sm text-[var(--color-red)]"
            onClick={async () => {
              await requestDeletion()
              router.refresh()
            }}
          >
            {t('deleteConfirm')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary w-full text-sm text-[var(--color-red)]"
            onClick={() => setConfirmDelete(true)}
          >
            {t('deleteAccount')}
          </button>
        )}
      </section>

      <p className="text-xs text-[var(--color-ink-3)] text-center">{locale.toUpperCase()}</p>
    </div>
  )
}
