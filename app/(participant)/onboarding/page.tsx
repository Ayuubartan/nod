import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { currentAuthId } from '@/lib/auth'
import { OnboardingFlow } from '@/components/participant/OnboardingFlow'
import { nextDropLabel } from '@/lib/marketplace'

/**
 * Onboarding — docs/02 A1, nine screens, target under five minutes.
 *
 * BankID is deliberately NOT here: it gates the first claim, not sign-up (docs/02 A1).
 */
export const dynamic = 'force-dynamic'

export default async function OnboardingPage() {
  const authId = await currentAuthId()

  const user = authId
    ? await prisma.user.findUnique({
        where: { authId },
        include: { accounts: { where: { deletedAt: null } } },
      })
    : null

  // Already onboarded — nothing to do here.
  if (user && user.state !== 'SIGNED_UP') redirect('/campaigns')

  return (
    <OnboardingFlow
      authId={authId}
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
    />
  )
}
