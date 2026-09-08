import { NextResponse } from 'next/server'
import { REF_COOKIE, REF_MAX_AGE_S } from '@/lib/referral-cookie'

/**
 * The short share link — joinbooga.se/r/8KF2Q (docs/13). Remembers the code in a
 * cookie and lands on the form with it filled in. Nothing is looked up here: an
 * unknown code is ignored by joinWaitlist, and the redirect must never leak whether
 * a code exists.
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }): Promise<Response> {
  const { code } = await params
  const clean = code.replace(/[^A-Za-z0-9]/g, '').slice(0, 16).toUpperCase()
  const url = new URL(request.url)
  const target = new URL(clean ? `/?ref=${clean}#waitlist` : '/#waitlist', url.origin)
  const response = NextResponse.redirect(target, 302)
  if (clean) {
    response.cookies.set(REF_COOKIE, clean, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: REF_MAX_AGE_S,
    })
  }
  return response
}
