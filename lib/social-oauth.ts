/**
 * OAuth start/callback for social accounts — docs/06 sections 1-2.
 *
 * Start writes a random `state` into a short-lived HttpOnly cookie and sends the
 * participant to the platform's consent screen with read-only scopes. The callback
 * checks the state against the cookie (CSRF: a code from someone else's consent can
 * not be attached to this session), then hands the code to `connectAccount`.
 */

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { randomToken, safeEqual } from '@/lib/crypto'
import { platformFromSlug, providerFor } from '@/lib/integrations/social'
import { connectAccount } from '@/app/(participant)/actions'

const STATE_COOKIE = 'NOD_OAUTH_STATE'
const STATE_TTL_S = 10 * 60

/** Where the participant lands afterwards; anything else falls back to /accounts. */
const RETURN_PATHS = new Set(['/accounts', '/onboarding'])

function siteUrl(request: Request): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin
}

export async function startSocialAuth(request: Request, slug: string): Promise<Response> {
  const base = siteUrl(request)
  const platform = platformFromSlug(slug)
  if (!platform) return NextResponse.redirect(`${base}/accounts?error=invalidPlatform`)

  const session = await getSession()
  if (!session || session.kind === 'brand') return NextResponse.redirect(`${base}/sign-in`)

  const requested = new URL(request.url).searchParams.get('returnTo') ?? '/accounts'
  const returnTo = RETURN_PATHS.has(requested) ? requested : '/accounts'

  const state = randomToken(18)
  const store = await cookies()
  store.set(STATE_COOKIE, `${state}:${returnTo}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: STATE_TTL_S,
  })

  const url = providerFor(platform).authUrl(state)
  // The fake provider answers with a relative callback URL.
  return NextResponse.redirect(url.startsWith('/') ? `${base}${url}` : url)
}

export async function finishSocialAuth(request: Request, slug: string): Promise<Response> {
  const base = siteUrl(request)
  const platform = platformFromSlug(slug)
  if (!platform) return NextResponse.redirect(`${base}/accounts?error=invalidPlatform`)

  const session = await getSession()
  if (!session || session.kind === 'brand') return NextResponse.redirect(`${base}/sign-in`)

  const params = new URL(request.url).searchParams
  const store = await cookies()
  const stored = store.get(STATE_COOKIE)?.value ?? ''
  store.delete(STATE_COOKIE)

  const [expectedState, storedReturn] = stored.split(':', 2)
  const returnTo = storedReturn && RETURN_PATHS.has(storedReturn) ? storedReturn : '/accounts'
  const back = (query: string) => NextResponse.redirect(`${base}${returnTo}?${query}`)

  // The platform sends `error` when the person pressed cancel on the consent screen.
  const code = params.get('code')
  if (!code) return back('error=denied')

  const state = params.get('state') ?? ''
  if (!expectedState || !state || !safeEqual(expectedState, state)) return back('error=state')

  const result = await connectAccount(code, platform)
  return back(result.ok ? `connected=${slug}` : `error=${result.error}`)
}
