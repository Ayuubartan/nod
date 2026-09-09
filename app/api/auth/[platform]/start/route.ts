import { startSocialAuth } from '@/lib/social-oauth'

/** `/api/auth/instagram/start`, `/api/auth/tiktok/start` — begin the read-only OAuth flow. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, ctx: { params: Promise<{ platform: string }> }): Promise<Response> {
  const { platform } = await ctx.params
  return startSocialAuth(request, platform)
}
