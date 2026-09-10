import { afterEach, describe, expect, it } from 'vitest'
import {
  emailIsVerified,
  enabledSocialProviders,
  isSocialProvider,
  parseState,
  signInErrorFrom,
} from '@/lib/social-signin'

/**
 * The pure surface of social sign-in. The OAuth round-trip itself needs a Supabase
 * project and a browser, so it is not asserted here — what is asserted is everything
 * that decides whether a button appears, whether a callback is trusted, and whether an
 * address may be linked to an existing account.
 */

const ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NOD_SOCIAL_PROVIDERS'] as const
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

function env(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

const SUPABASE = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
}

describe('enabledSocialProviders — docs/08 "Auth: Supabase Auth (Apple, Google)"', () => {
  it('shows nothing when neither Supabase nor a provider list is configured', () => {
    env({})
    expect(enabledSocialProviders()).toEqual([])
  })

  it('shows nothing when Supabase is configured but no provider is listed', () => {
    // The state every environment is in today: Supabase Auth exists but nobody has
    // enabled a provider in its dashboard, so a button would only lead to an error.
    env(SUPABASE)
    expect(enabledSocialProviders()).toEqual([])
  })

  it('shows nothing when providers are listed but Supabase is missing', () => {
    // Production runs on Neon; listing a provider there must not put a dead button on
    // the sign-in page.
    env({ NOD_SOCIAL_PROVIDERS: 'google,apple' })
    expect(enabledSocialProviders()).toEqual([])
  })

  it('shows only the providers listed, in a stable order', () => {
    env({ ...SUPABASE, NOD_SOCIAL_PROVIDERS: 'apple, GOOGLE ' })
    expect(enabledSocialProviders()).toEqual(['google', 'apple'])
  })

  it('ignores names that are not supported providers', () => {
    env({ ...SUPABASE, NOD_SOCIAL_PROVIDERS: 'google,facebook,,x' })
    expect(enabledSocialProviders()).toEqual(['google'])
  })

  it('accepts a single provider', () => {
    env({ ...SUPABASE, NOD_SOCIAL_PROVIDERS: 'google' })
    expect(enabledSocialProviders()).toEqual(['google'])
  })
})

describe('isSocialProvider', () => {
  it('accepts the supported providers and nothing else', () => {
    expect(isSocialProvider('google')).toBe(true)
    expect(isSocialProvider('apple')).toBe(true)
    expect(isSocialProvider('facebook')).toBe(false)
    expect(isSocialProvider('../callback')).toBe(false)
    expect(isSocialProvider('')).toBe(false)
  })
})

describe('emailIsVerified — an unverified address must never link to an existing account', () => {
  it('trusts a Supabase-confirmed address', () => {
    expect(emailIsVerified({ email_confirmed_at: '2026-09-10T10:00:00Z' })).toBe(true)
    expect(emailIsVerified({ confirmed_at: '2026-09-10T10:00:00Z' })).toBe(true)
  })

  it('trusts the provider claim in either shape', () => {
    expect(emailIsVerified({ user_metadata: { email_verified: true } })).toBe(true)
    expect(emailIsVerified({ user_metadata: { email_verified: 'true' } })).toBe(true)
  })

  it('rejects an unverified, absent or falsely-shaped claim', () => {
    expect(emailIsVerified({})).toBe(false)
    expect(emailIsVerified({ email_confirmed_at: null, confirmed_at: null })).toBe(false)
    expect(emailIsVerified({ user_metadata: { email_verified: false } })).toBe(false)
    expect(emailIsVerified({ user_metadata: { email_verified: 'yes' } })).toBe(false)
    expect(emailIsVerified({ user_metadata: null })).toBe(false)
  })
})

describe('parseState — a callback is only trusted when this browser started the sign-in', () => {
  it('reads back what start wrote', () => {
    expect(parseState(JSON.stringify({ state: 'abc', audience: 'BRAND', next: '/brand/campaigns' }))).toEqual({
      state: 'abc',
      audience: 'BRAND',
      next: '/brand/campaigns',
    })
  })

  it('defaults an unknown or missing audience to the creator form', () => {
    expect(parseState(JSON.stringify({ state: 'abc' }))).toEqual({
      state: 'abc',
      audience: 'PARTICIPANT',
      next: null,
    })
    expect(parseState(JSON.stringify({ state: 'abc', audience: 'OPS' }))?.audience).toBe('PARTICIPANT')
  })

  it('is null for a missing, truncated, empty or non-object cookie', () => {
    expect(parseState(undefined)).toBeNull()
    expect(parseState('')).toBeNull()
    expect(parseState('{"state":"abc"')).toBeNull()
    expect(parseState('null')).toBeNull()
    expect(parseState('"abc"')).toBeNull()
    expect(parseState(JSON.stringify({ state: '' }))).toBeNull()
    expect(parseState(JSON.stringify({ state: 42 }))).toBeNull()
    expect(parseState(JSON.stringify({ audience: 'BRAND' }))).toBeNull()
  })

  it('drops a non-string next rather than carrying it into safeNext', () => {
    expect(parseState(JSON.stringify({ state: 'abc', next: { evil: true } }))?.next).toBeNull()
  })
})

describe('signInErrorFrom — ?error= comes from the address bar', () => {
  it('lets the codes this app produces through', () => {
    expect(signInErrorFrom('socialDenied')).toBe('socialDenied')
    expect(signInErrorFrom('waitlistOnly')).toBe('waitlistOnly')
    expect(signInErrorFrom('noBrandAccount')).toBe('noBrandAccount')
  })

  it('drops anything else, so no arbitrary string reaches the translation lookup', () => {
    expect(signInErrorFrom('errors.socialDenied')).toBeNull()
    expect(signInErrorFrom('<script>alert(1)</script>')).toBeNull()
    expect(signInErrorFrom('toQueue')).toBeNull()
    expect(signInErrorFrom('')).toBeNull()
    expect(signInErrorFrom(null)).toBeNull()
    expect(signInErrorFrom(undefined)).toBeNull()
  })
})
