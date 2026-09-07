import { getTranslations } from 'next-intl/server'
import { requireParticipant } from '@/lib/auth'
import { SettingsPanel } from '@/components/participant/SettingsPanel'
import { tryDecrypt } from '@/lib/crypto'
import { SignOutButton } from '@/components/SignOutButton'

/** Settings — docs/02 A7, including the GDPR rights from docs/07 section 3. */
export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const user = await requireParticipant()
  const t = await getTranslations('settings')

  // Shown masked: the participant should be able to confirm it without exposing it to
  // a shoulder-surfer or a screenshot.
  const swish = tryDecrypt(user.swishNumber)
  const maskedSwish = swish ? `${swish.slice(0, 6)}•••${swish.slice(-2)}` : null

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl mb-6">{t('title')}</h1>
      <SettingsPanel
        trainingConsent={user.trainingConsent}
        maskedSwish={maskedSwish}
        deletionRequestedAt={user.deletionRequestedAt?.toISOString() ?? null}
        locale={user.locale === 'en' ? 'en' : 'sv'}
      />
      <div className="mt-8 text-center">
        <SignOutButton className="underline" />
      </div>
    </div>
  )
}
