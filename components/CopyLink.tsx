'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { EVENTS, track } from '@/lib/analytics'

export function CopyLink({ value }: { value: string }) {
  const t = useTranslations('common')
  const [copied, setCopied] = useState(false)

  return (
    <div className="grid gap-2">
      <code className="text-sm tabular bg-[var(--color-bg)] border border-[var(--color-line)] rounded-lg px-3 py-2 break-all">
        {value}
      </code>
      <button
        type="button"
        className="btn btn-primary w-full"
        onClick={() => {
          void navigator.clipboard.writeText(value)
          setCopied(true)
          track(EVENTS.referralLinkCopied, {})
        }}
      >
        {copied ? t('copied') : t('copy')}
      </button>
    </div>
  )
}
