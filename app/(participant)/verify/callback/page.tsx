import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { completeBankId } from '@/app/(participant)/actions'

/** The broker redirects here after BankID. Completing is a server round trip. */
export const dynamic = 'force-dynamic'

export default async function BankIdCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('verify')
  const params = await searchParams

  const payload: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') payload[key] = value
  }

  const result = await completeBankId(payload)
  if (result.ok) redirect('/campaigns')

  return (
    <div className="max-w-md mx-auto card p-6 text-center">
      <h1 className="text-xl mb-2">{t('failed')}</h1>
      <p className="text-sm text-[var(--color-ink-2)]">
        {result.error === 'under18' ? t('under18') : result.error === 'duplicate' ? t('duplicate') : t('failed')}
      </p>
    </div>
  )
}
