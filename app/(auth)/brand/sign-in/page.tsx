import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSession } from '@/lib/auth'
import { safeNext } from '@/lib/login'
import { LoginForm } from '@/components/LoginForm'
import { enabledSocialProviders, signInErrorFrom } from '@/lib/social-signin'

/**
 * Brand sign-in — email code to an address ops has already attached to a Brand
 * (docs/02 section B). No self-serve signup by design (docs/09 "Not in scope"), which
 * social sign-in does not change: a provider proves the address, and an address with no
 * BrandUser still gets `noBrandAccount`.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: t('brandPageTitle') }
}

export default async function BrandSignInPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams
  const session = await getSession()
  if (session?.kind === 'brand' || session?.kind === 'ops') redirect(safeNext(next, '/brand/campaigns'))
  if (session?.kind === 'participant') redirect('/campaigns')

  return (
    <LoginForm
      audience="BRAND"
      next={next ?? null}
      providers={enabledSocialProviders()}
      initialError={signInErrorFrom(error)}
    />
  )
}
