/**
 * Social sign-in (Google, Apple) — docs/08 "Auth: Supabase Auth (phone OTP, Apple,
 * Google, magic link)", the one method docs/11 still listed as unwired.
 *
 * The shape is deliberately the same as the email code flow rather than a second
 * identity system beside it. Supabase proves the address; everything after that is
 * `resolveIdentity` from lib/login.ts — the same function the code flow calls — so the
 * waitlist gate, the OPS_EMAIL rule, the brand allowlist and the onboarding hand-off
 * behave identically whichever button the person pressed. The result is NOD's own
 * signed cookie (lib/session.ts), and the Supabase session is ended immediately: two
 * live sessions for one person is a signing-out bug waiting to happen.
 *
 * Linking is by verified address. Someone who signed up with a code and later presses
 * "Continue with Google" on the same address lands on the same User row, because
 * `resolveIdentity` looks the address up before minting anything.
 *
 * Routes: /api/sign-in/{provider}/start and /api/sign-in/callback. The connect-an-
 * account OAuth (Instagram/TikTok, lib/social-oauth.ts) lives under /api/auth/* and is
 * a different thing entirely — that one attaches a platform to a session, this one
 * creates the session.
 */

import { cookies, headers } from 'next/headers'
import { NextResponse } from 'next/server'
import type { LoginAudience } from '@prisma/client'
import type { LoginError } from './login'
import { supabaseServer } from './auth'
import { randomToken, safeEqual } from './crypto'
import { normaliseEmail, resolveIdentity, safeNext } from './login'
import { rateLimit } from './rate-limit'
import { setSession } from './session'

export const SOCIAL_PROVIDERS = ['google', 'apple'] as const
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number]

export function isSocialProvider(value: string): value is SocialProvider {
  return (SOCIAL_PROVIDERS as readonly string[]).includes(value)
}

/** Errors this flow can end in, over and above the ones resolveIdentity returns. */
export type SocialSignInError =
  | 'socialUnavailable'
  | 'socialDenied'
  | 'socialState'
  | 'socialNoEmail'
  | 'socialUnverified'
  | 'socialFailed'

/** Everything either flow can put in `?error=` on a sign-in page. */
export type SignInError = LoginError | SocialSignInError

const SIGN_IN_ERRORS: readonly SignInError[] = [
  'invalidEmail',
  'rateLimited',
  'noCode',
  'wrongCode',
  'tooManyAttempts',
  'noBrandAccount',
  'waitlistOnly',
  'socialUnavailable',
  'socialDenied',
  'socialState',
  'socialNoEmail',
  'socialUnverified',
  'socialFailed',
]

/**
 * `?error=` arrives from the address bar, so anyone can put anything there. The form
 * looks the value up as a translation key, and an unknown key renders as the raw key —
 * an open door for injected text. Only the codes this app actually produces get through.
 */
export function signInErrorFrom(raw: string | null | undefined): SignInError | null {
  return raw && (SIGN_IN_ERRORS as readonly string[]).includes(raw) ? (raw as SignInError) : null
}

const STATE_COOKIE = 'NOD_SOCIAL_STATE'
const STATE_TTL_S = 10 * 60
const CALLBACK_PATH = '/api/sign-in/callback'

/**
 * Which buttons to show.
 *
 * DECISION: an explicit `NOD_SOCIAL_PROVIDERS` list rather than "Supabase is configured,
 * so show both". Google and Apple are enabled one at a time in the Supabase dashboard,
 * and Apple in particular needs a paid developer account; a button that leads to a
 * provider error is worse than no button. Unset means email code only, which is what
 * every environment does today.
 */
export function enabledSocialProviders(): SocialProvider[] {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return []
  const configured = (process.env.NOD_SOCIAL_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return SOCIAL_PROVIDERS.filter((p) => configured.includes(p))
}

function siteUrl(request: Request): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin
}

function signInPath(audience: LoginAudience): string {
  return audience === 'BRAND' ? '/brand/sign-in' : '/sign-in'
}

/** Back to the form the person came from, with an error it knows how to render. */
function backToForm(base: string, audience: LoginAudience, error: string, next: string | null): Response {
  const url = new URL(`${base}${signInPath(audience)}`)
  url.searchParams.set('error', error)
  if (next) url.searchParams.set('next', next)
  return NextResponse.redirect(url.toString())
}

async function clientIp(): Promise<string> {
  const head = await headers()
  return head.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

/**
 * Step one: park the state and send the person to the provider.
 *
 * The state cookie carries the audience and the post-login destination as well as the
 * random nonce, so the callback needs no query parameters it did not itself set — a
 * callback URL someone else forged has nothing to match against.
 */
export async function startSocialSignIn(request: Request, provider: string): Promise<Response> {
  const base = siteUrl(request)
  const params = new URL(request.url).searchParams
  const audience: LoginAudience = params.get('audience') === 'BRAND' ? 'BRAND' : 'PARTICIPANT'
  const next = params.get('next')

  if (!isSocialProvider(provider) || !enabledSocialProviders().includes(provider)) {
    return backToForm(base, audience, 'socialUnavailable', next)
  }
  if (!(await rateLimit(`social-start:${await clientIp()}`, 20, 15 * 60_000))) {
    return backToForm(base, audience, 'rateLimited', next)
  }

  const state = randomToken(18)
  const store = await cookies()
  store.set(STATE_COOKIE, JSON.stringify({ state, audience, next: next ?? null }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/sign-in',
    maxAge: STATE_TTL_S,
  })

  try {
    const supabase = await supabaseServer()
    // skipBrowserRedirect: this is a route handler, so we do the redirecting. The
    // client writes the PKCE verifier into its own cookie as a side effect, which is
    // why the exchange in the callback works without us handling the verifier.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${base}${CALLBACK_PATH}`,
        skipBrowserRedirect: true,
      },
    })
    if (error || !data?.url) return backToForm(base, audience, 'socialUnavailable', next)
    return NextResponse.redirect(data.url)
  } catch {
    return backToForm(base, audience, 'socialUnavailable', next)
  }
}

/**
 * Step two: prove the address, then hand over to the same identity resolution the code
 * flow uses.
 *
 * An address is only trusted when the provider says it is verified. Without that check
 * a provider that lets an account claim an unverified address would be a way into
 * someone else's NOD account, since linking is by address.
 */
export async function finishSocialSignIn(request: Request): Promise<Response> {
  const base = siteUrl(request)
  const store = await cookies()
  const raw = store.get(STATE_COOKIE)?.value
  // Deleting without the path it was set on leaves the cookie in the browser.
  store.delete({ name: STATE_COOKIE, path: '/api/sign-in' })

  const parsed = parseState(raw)
  if (!parsed) return backToForm(base, 'PARTICIPANT', 'socialState', null)
  const { audience, next } = parsed
  const back = (error: string) => backToForm(base, audience, error, next)

  const params = new URL(request.url).searchParams
  // The provider sends `error` when the person cancelled on the consent screen.
  if (params.get('error')) return back('socialDenied')

  const state = params.get('state')
  // Supabase's PKCE flow does not round-trip our state, so it is absent here and the
  // cookie alone is the proof that this browser started a sign-in. When a state does
  // come back it must match.
  if (state && !safeEqual(parsed.state, state)) return back('socialState')

  const code = params.get('code')
  if (!code) return back('socialDenied')

  if (!(await rateLimit(`social-callback:${await clientIp()}`, 20, 15 * 60_000))) {
    return back('rateLimited')
  }

  let email: string
  try {
    const supabase = await supabaseServer()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (error || !data?.user) return back('socialFailed')

    const user = data.user
    // The same normalisation verifyCode applies before resolveIdentity, so an address
    // links to exactly the same row whichever way it was proved.
    const normalised = normaliseEmail(user.email ?? '')
    // End the provider session at once: NOD's cookie is the session from here on, and
    // signOutEverywhere should not have to end two of them. Local scope only — there is
    // no other Supabase session of ours to revoke.
    await supabase.auth.signOut({ scope: 'local' })

    if (!normalised) return back('socialNoEmail')
    if (!emailIsVerified(user)) return back('socialUnverified')
    email = normalised
  } catch {
    return back('socialFailed')
  }

  const identity = await resolveIdentity(email, audience)
  if (!identity.ok) return back(identity.error)

  await setSession(identity.authId, identity.email)
  return NextResponse.redirect(`${base}${safeNext(next, identity.next)}`)
}

/** Exported for tests: a tampered or truncated cookie must read as no state at all. */
export function parseState(raw: string | undefined): { state: string; audience: LoginAudience; next: string | null } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; audience?: unknown; next?: unknown }
    if (typeof parsed.state !== 'string' || !parsed.state) return null
    return {
      state: parsed.state,
      audience: parsed.audience === 'BRAND' ? 'BRAND' : 'PARTICIPANT',
      next: typeof parsed.next === 'string' ? parsed.next : null,
    }
  } catch {
    return null
  }
}

/**
 * Supabase confirms the address itself for OAuth providers that assert it, and mirrors
 * the provider's own claim into the identity metadata. Apple only returns an address on
 * the first authorization, so `email_confirmed_at` is what carries the fact afterwards.
 */
export function emailIsVerified(user: {
  email_confirmed_at?: string | null
  confirmed_at?: string | null
  user_metadata?: Record<string, unknown> | null
}): boolean {
  if (user.email_confirmed_at || user.confirmed_at) return true
  const claim = user.user_metadata?.email_verified
  return claim === true || claim === 'true'
}
