import { finishSocialSignIn } from '@/lib/social-signin'

/**
 * `/api/sign-in/google/callback`, `/api/sign-in/facebook/callback`.
 *
 * One path per provider: providers match redirect URIs exactly, so each gets its own
 * registered URI and a code issued for one can never be presented as the other. Both
 * must be registered at the provider or the round-trip fails there, not here (docs/12).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await ctx.params
  return finishSocialSignIn(request, provider)
}
