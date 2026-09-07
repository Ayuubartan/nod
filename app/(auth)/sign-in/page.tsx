import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { safeNext } from '@/lib/login'
import { LoginForm } from '@/components/LoginForm'

/** Creator sign-in — email code (docs/02 A1). Already signed in? Straight through. */
export const dynamic = 'force-dynamic'

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams
  const session = await getSession()
  if (session?.kind === 'participant') redirect(safeNext(next, '/campaigns'))
  if (session?.kind === 'ops') redirect('/ops')
  if (session?.kind === 'brand') redirect('/brand/campaigns')

  return <LoginForm audience="PARTICIPANT" next={next ?? null} />
}
