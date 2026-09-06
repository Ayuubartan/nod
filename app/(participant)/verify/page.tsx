import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requireParticipant } from '@/lib/auth'
import { BankIdFlow } from '@/components/participant/BankIdFlow'

/**
 * BankID — docs/09 M1 task 6: "the gate is on first claim, but build the flow now and
 * expose it at /verify for testing".
 */
export const dynamic = 'force-dynamic'

export default async function VerifyPage() {
  const user = await requireParticipant()
  const t = await getTranslations('verify')

  if (['VERIFIED', 'ACTIVE', 'FLAGGED'].includes(user.state)) redirect('/campaigns')
  if (user.state === 'SIGNED_UP') redirect('/onboarding')

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl mb-1">{t('title')}</h1>
      <p className="text-sm text-[var(--color-ink-2)] mb-6">{t('sub')}</p>
      <BankIdFlow />
    </div>
  )
}
