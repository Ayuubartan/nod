import { startSocialSignIn } from '@/lib/social-signin'

/** `/api/sign-in/google/start`, `/api/sign-in/apple/start` — begin social sign-in. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await ctx.params
  return startSocialSignIn(request, provider)
}
