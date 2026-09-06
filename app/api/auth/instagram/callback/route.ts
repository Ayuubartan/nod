import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { connectAccount } from '@/app/(participant)/actions'

/** Instagram OAuth callback — exchanges the code and stores the encrypted token. */
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? url.origin

  const session = await getSession()
  if (!session || session.kind === 'brand') {
    return NextResponse.redirect(`${siteUrl}/onboarding`)
  }
  if (!code) {
    return NextResponse.redirect(`${siteUrl}/accounts?error=denied`)
  }

  const result = await connectAccount(code)
  return NextResponse.redirect(
    result.ok ? `${siteUrl}/accounts?connected=1` : `${siteUrl}/accounts?error=${result.error}`,
  )
}
