import { finishSocialSignIn } from '@/lib/social-signin'

/**
 * The one redirect URL every social provider comes back to. It must also be on
 * Supabase's Redirect URLs allowlist, or Supabase sends the browser to the Site URL
 * instead and nothing here ever runs (docs/12).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  return finishSocialSignIn(request)
}
