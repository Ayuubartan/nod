import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { currentAuthId } from '@/lib/auth'
import { readSession } from '@/lib/session'
import { OnboardingFlow } from '@/components/participant/OnboardingFlow'
import { nextDropLabel } from '@/lib/marketplace'
import { prefillFromWaitlist } from '@/lib/waitlist'
import { usesFake } from '@/lib/integrations/social'
import { getTranslations } from 'next-intl/server'

/**
 * Onboarding — docs/02 A1, five screens, target under three minutes.
 *
 * Someone who joined the waitlist first has already told us their city, age and
 * handle; those come back as defaults so the waitlist is the first half of
 * onboarding rather than a separate form (lib/waitlist.ts).
 *
 * BankID is deliberately NOT here: it gates the first claim, not sign-up (docs/02 A1).
 * Sign-in is: the email code (/sign-in) proves an address and mints the auth id that
 * the User row is created under on screen 1.
 */
export const dynamic = 'force-dynamic'

const CONNECT_ERRORS = ['denied', 'state', 'connectFailed', 'accountTaken'] as const

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const authId = await currentAuthId()
  if (!authId) redirect('/sign-in?next=/onboarding')
  const session = await readSession()
  const email = session?.email ?? null
  const name = session?.name ?? null

  const user = authId
    ? await prisma.user.findUnique({
        where: { authId },
        include: { accounts: { where: { deletedAt: null } } },
      })
    : null

  // Already onboarded — nothing to do here.
  if (user && user.state !== 'SIGNED_UP') redirect('/campaigns')

  const prefill = user ? null : await prefillFromWaitlist(email)

  // A cancelled or failed OAuth round-trip lands back here with `?error=`.
  const { error } = await searchParams
  const errorKey = CONNECT_ERRORS.find((k) => k === error)
  const connectError = errorKey ? (await getTranslations('onboarding'))(`connect.error.${errorKey}`) : null

  return (
    <OnboardingFlow
      authId={authId}
      email={email}
      name={name}
      existing={
        user
          ? {
              id: user.id,
              city: user.city,
              ageBracket: user.ageBracket,
              accounts: user.accounts.map((a) => ({
                id: a.id,
                handle: a.handle,
                tier: a.tier,
                followers: a.followers,
                avgViews30d: a.avgViews30d,
                accountType: a.accountType,
              })),
              referralCode: user.referralCode,
            }
          : null
      }
      nextDrop={nextDropLabel().toISOString()}
      prefill={prefill}
      oauth={{ INSTAGRAM: !usesFake('INSTAGRAM'), TIKTOK: !usesFake('TIKTOK') }}
      connectError={connectError}
    />
  )
}
