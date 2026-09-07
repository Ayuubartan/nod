'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { signOut } from '@/app/(auth)/actions'

export function SignOutButton({ className = '' }: { className?: string }) {
  const t = useTranslations('auth')
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      className={`text-sm text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-50 ${className}`}
      disabled={pending}
      onClick={() => start(() => signOut())}
    >
      {t('signOut')}
    </button>
  )
}
