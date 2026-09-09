import { finishSocialAuth } from '@/lib/social-oauth'

/** OAuth callback — checks the state, exchanges the code and stores the encrypted tokens. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: { params: Promise<{ platform: string }> }): Promise<Response> {
  const { platform } = await ctx.params
  return finishSocialAuth(request, platform)
}
