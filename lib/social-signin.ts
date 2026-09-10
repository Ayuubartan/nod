/**
 * Social sign-in (Google, Facebook) — docs/08 "Auth: ... Apple, Google".
 *
 * The shape is deliberately the same as the email code flow rather than a second
 * identity system beside it. A provider proves the address; everything after that is
 * `resolveIdentity` from lib/login.ts — the same function the code flow calls — so the
 * waitlist gate, the OPS_EMAIL rule, the brand allowlist and the onboarding hand-off
 * behave identically whichever button the person pressed. The result is NOD's own
 * signed cookie (lib/session.ts).
 *
 * Linking is by verified address. Someone who signed up with a code and later presses
 * "Continue with Google" on the same address lands on the same User row, because
 * `resolveIdentity` looks the address up before minting anything. That is only safe
 * because of the check beside it: an address is trusted only when the provider says it
 * is verified. Without it, a provider that lets an account assert an unverified address
 * would be a way into someone else's NOD account.
 *
 * Routes: /api/sign-in/{provider}/start and /api/sign-in/{provider}/callback. The
 * connect-an-account OAuth (Instagram/TikTok, lib/social-oauth.ts) lives under
 * /api/auth/* and is a different thing entirely — that one attaches a platform to a
 * session, this one creates the session.
 */

import { cookies, headers } from 'next/headers'
import { NextResponse } from 'next/server'
import type { LoginAudience } from '@prisma/client'
import { randomToken, safeEqual } from './crypto'
import type { LoginError } from './login'
import { normaliseEmail, resolveIdentity, safeNext } from './login'
import { rateLimit } from './rate-limit'
import { setSession } from './session'
import { adapterFor, type SignInProvider } from './signin-providers'

export const SOCIAL_PROVIDERS = ['google', 'facebook'] as const
export type SocialProvider = SignInProvider

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

/**
 * Which buttons to show: listed in `NOD_SOCIAL_PROVIDERS` **and** actually holding both
 * halves of its credential pair.
 *
 * Both conditions, because either alone produces a dead button. The list is explicit so
 * that setting `META_APP_ID` for the Instagram connection does not silently put a
 * "Continue with Facebook" button on the sign-in page before Facebook Login has been
 * added as a product on that app — exactly the case a credential check alone misses.
 *
 * `NOD_FAKE_PROVIDERS` is deliberately not consulted. It simulates *connecting an
 * account*; a simulated way to become any user is not a thing sign-in should have. The
 * /dev persona cookie already covers local work.
 */
export function enabledSocialProviders(): SocialProvider[] {
  const configured = (process.env.NOD_SOCIAL_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return SOCIAL_PROVIDERS.filter((p) => configured.includes(p) && adapterFor(p).configured())
}

function siteUrl(request: Request): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin
}

/**
 * Each provider gets its own callback path, mirroring /api/auth/[platform]/callback.
 * Providers match redirect URIs exactly, so one path per provider is one registered URI
 * per provider — and no way for a code issued for one to be presented as the other.
 */
export function callbackPath(provider: SocialProvider): string {
  return `/api/sign-in/${provider}/callback`
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
 * The cookie carries the provider, the audience and the destination as well as the
 * random nonce, so the callback needs no query parameter it did not itself set.
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
  store.set(STATE_COOKIE, JSON.stringify({ state, provider, audience, next: next ?? null }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/sign-in',
    maxAge: STATE_TTL_S,
  })

  return NextResponse.redirect(
    adapterFor(provider).authUrl({ state, redirectUri: `${base}${callbackPath(provider)}` }),
  )
}

/**
 * Step two: prove the address, then hand over to the same identity resolution the code
 * flow uses.
 */
export async function finishSocialSignIn(request: Request, provider: string): Promise<Response> {
  const base = siteUrl(request)
  const store = await cookies()
  const raw = store.get(STATE_COOKIE)?.value
  // Deleting without the path it was set on leaves the cookie in the browser.
  store.delete({ name: STATE_COOKIE, path: '/api/sign-in' })

  const parsed = parseState(raw)
  if (!parsed) return backToForm(base, 'PARTICIPANT', 'socialState', null)
  const { audience, next } = parsed
  const back = (error: string) => backToForm(base, audience, error, next)

  // The code was issued for whichever provider started the flow; a callback for a
  // different one means the cookie and the URL disagree, so neither is trusted.
  if (!isSocialProvider(provider) || provider !== parsed.provider) return back('socialState')

  const params = new URL(request.url).searchParams
  // Providers send `error` when the person pressed cancel on the consent screen.
  if (params.get('error')) return back('socialDenied')

  // Direct OAuth always round-trips `state`, so its absence is a defect, not a variant.
  const state = params.get('state') ?? ''
  if (!state || !safeEqual(parsed.state, state)) return back('socialState')

  const code = params.get('code')
  if (!code) return back('socialDenied')

  if (!(await rateLimit(`social-callback:${await clientIp()}`, 20, 15 * 60_000))) {
    return back('rateLimited')
  }

  let email: string
  let name: string | null
  try {
    const profile = await adapterFor(provider).exchange({
      code,
      redirectUri: `${base}${callbackPath(provider)}`,
    })
    // The same normalisation verifyCode applies before resolveIdentity, so an address
    // links to exactly the same row whichever way it was proved.
    const normalised = normaliseEmail(profile.email)
    if (!normalised) return back('socialNoEmail')
    if (!profile.emailVerified) return back('socialUnverified')
    email = normalised
    name = profile.name
  } catch {
    // Provider outage, revoked app, expired code — never a reason to blame the person.
    return back('socialFailed')
  }

  const identity = await resolveIdentity(email, audience)
  if (!identity.ok) return back(identity.error)

  await setSession(identity.authId, identity.email, name)
  return NextResponse.redirect(`${base}${safeNext(next, identity.next)}`)
}

/** Exported for tests: a tampered or truncated cookie must read as no state at all. */
export function parseState(
  raw: string | undefined,
): { state: string; provider: SocialProvider; audience: LoginAudience; next: string | null } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; provider?: unknown; audience?: unknown; next?: unknown }
    if (typeof parsed.state !== 'string' || !parsed.state) return null
    if (typeof parsed.provider !== 'string' || !isSocialProvider(parsed.provider)) return null
    return {
      state: parsed.state,
      provider: parsed.provider,
      audience: parsed.audience === 'BRAND' ? 'BRAND' : 'PARTICIPANT',
      next: typeof parsed.next === 'string' ? parsed.next : null,
    }
  } catch {
    return null
  }
}
