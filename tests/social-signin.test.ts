import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callbackPath,
  enabledSocialProviders,
  isSocialProvider,
  parseState,
  signInErrorFrom,
} from '@/lib/social-signin'
import { facebookAdapter, googleAdapter } from '@/lib/signin-providers'

/**
 * The parts of social sign-in that can be asserted without a browser and a real
 * provider: what decides whether a button appears, what an adapter asks the provider
 * for, what it makes of the answer, and whether a callback is trusted.
 *
 * The OAuth round-trip itself is not asserted — it needs registered credentials at
 * Google and Meta. The exchanges below are against a mocked `fetch`.
 */

const ENV_KEYS = ['NOD_SOCIAL_PROVIDERS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'META_APP_ID', 'META_APP_SECRET'] as const
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
  vi.unstubAllGlobals()
})

const GOOGLE = { GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret' }
const META = { META_APP_ID: 'm-id', META_APP_SECRET: 'm-secret' }

describe('enabledSocialProviders — a listed provider without credentials is a dead button', () => {
  it('shows nothing when nothing is configured', () => {
    env({})
    expect(enabledSocialProviders()).toEqual([])
  })

  it('shows nothing when listed but the credentials are missing', () => {
    env({ NOD_SOCIAL_PROVIDERS: 'google,facebook' })
    expect(enabledSocialProviders()).toEqual([])
  })

  it('shows nothing when the credentials exist but the provider is not listed', () => {
    // The case the explicit list exists for: META_APP_ID is set for the Instagram
    // connection long before Facebook Login is added as a product on that app.
    env({ ...GOOGLE, ...META })
    expect(enabledSocialProviders()).toEqual([])
  })

  it('needs both halves of a credential pair', () => {
    env({ NOD_SOCIAL_PROVIDERS: 'google', GOOGLE_CLIENT_ID: 'g-id' })
    expect(enabledSocialProviders()).toEqual([])
  })

  it('shows a provider that is both listed and configured', () => {
    env({ NOD_SOCIAL_PROVIDERS: 'google', ...GOOGLE })
    expect(enabledSocialProviders()).toEqual(['google'])
  })

  it('shows both, in a stable order, whatever order they were listed in', () => {
    env({ NOD_SOCIAL_PROVIDERS: ' FACEBOOK , google ', ...GOOGLE, ...META })
    expect(enabledSocialProviders()).toEqual(['google', 'facebook'])
  })

  it('ignores names that are not supported providers', () => {
    env({ NOD_SOCIAL_PROVIDERS: 'google,apple,,x', ...GOOGLE, ...META })
    expect(enabledSocialProviders()).toEqual(['google'])
  })
})

describe('isSocialProvider / callbackPath', () => {
  it('accepts the supported providers and nothing else', () => {
    expect(isSocialProvider('google')).toBe(true)
    expect(isSocialProvider('facebook')).toBe(true)
    expect(isSocialProvider('apple')).toBe(false)
    expect(isSocialProvider('../callback')).toBe(false)
    expect(isSocialProvider('')).toBe(false)
  })

  it('gives each provider its own callback path', () => {
    // Providers match redirect URIs exactly; one path each is one registered URI each.
    expect(callbackPath('google')).toBe('/api/sign-in/google/callback')
    expect(callbackPath('facebook')).toBe('/api/sign-in/facebook/callback')
  })
})

describe('googleAdapter', () => {
  beforeEach(() => env({ ...GOOGLE }))

  it('asks only for read scopes and round-trips the state', () => {
    const url = new URL(googleAdapter.authUrl({ state: 'st-1', redirectUri: 'https://x.se/cb' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('g-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://x.se/cb')
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('response_type')).toBe('code')
    // CLAUDE.md rule 6: nothing that could write on someone's behalf.
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('access_type')).toBe('online')
  })

  it('reads the profile from the userinfo response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('oauth2.googleapis.com')
          ? { ok: true, json: async () => ({ access_token: 'tok' }) }
          : {
              ok: true,
              json: async () => ({ sub: '123', email: 'A@Example.SE', email_verified: true, name: '  Anna Ek  ' }),
            },
      ),
    )
    await expect(googleAdapter.exchange({ code: 'c', redirectUri: 'https://x.se/cb' })).resolves.toEqual({
      providerUserId: '123',
      email: 'A@Example.SE',
      emailVerified: true,
      name: 'Anna Ek',
    })
  })

  it('treats the string "true" as verified and anything else as not', async () => {
    const withVerified = (value: unknown) =>
      vi.fn(async (input: string) =>
        input.includes('oauth2.googleapis.com')
          ? { ok: true, json: async () => ({ access_token: 'tok' }) }
          : { ok: true, json: async () => ({ sub: '1', email: 'a@b.se', email_verified: value }) },
      )

    vi.stubGlobal('fetch', withVerified('true'))
    expect((await googleAdapter.exchange({ code: 'c', redirectUri: 'r' })).emailVerified).toBe(true)

    vi.stubGlobal('fetch', withVerified(false))
    expect((await googleAdapter.exchange({ code: 'c', redirectUri: 'r' })).emailVerified).toBe(false)

    vi.stubGlobal('fetch', withVerified(undefined))
    expect((await googleAdapter.exchange({ code: 'c', redirectUri: 'r' })).emailVerified).toBe(false)
  })

  it('throws when the token endpoint fails, so the caller shows socialFailed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })))
    await expect(googleAdapter.exchange({ code: 'c', redirectUri: 'r' })).rejects.toThrow()
  })
})

describe('facebookAdapter', () => {
  beforeEach(() => env({ ...META }))

  it('reuses the Meta app and asks only for public_profile and email', () => {
    const url = new URL(facebookAdapter.authUrl({ state: 'st-2', redirectUri: 'https://x.se/cb' }))
    expect(url.origin).toBe('https://www.facebook.com')
    expect(url.searchParams.get('client_id')).toBe('m-id')
    expect(url.searchParams.get('state')).toBe('st-2')
    expect(url.searchParams.get('scope')).toBe('public_profile,email')
  })

  it('is configured by the same variables as the Instagram connection', () => {
    expect(facebookAdapter.configured()).toBe(true)
    env({ META_APP_ID: 'm-id' })
    expect(facebookAdapter.configured()).toBe(false)
  })

  it('treats a returned address as verified — Facebook omits unconfirmed ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('oauth/access_token')
          ? { ok: true, json: async () => ({ access_token: 'tok' }) }
          : { ok: true, json: async () => ({ id: '77', name: 'Bo Ek', email: 'bo@ek.se' }) },
      ),
    )
    await expect(facebookAdapter.exchange({ code: 'c', redirectUri: 'r' })).resolves.toEqual({
      providerUserId: '77',
      email: 'bo@ek.se',
      emailVerified: true,
      name: 'Bo Ek',
    })
  })

  it('reports no email when the person registered by phone or declined the permission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input.includes('oauth/access_token')
          ? { ok: true, json: async () => ({ access_token: 'tok' }) }
          : { ok: true, json: async () => ({ id: '77', name: 'Bo Ek' }) },
      ),
    )
    const profile = await facebookAdapter.exchange({ code: 'c', redirectUri: 'r' })
    // Empty address → normaliseEmail returns null → socialNoEmail, never a signed-in
    // session with no address.
    expect(profile.email).toBe('')
    expect(profile.emailVerified).toBe(false)
  })
})

describe('parseState — a callback is only trusted when this browser started the sign-in', () => {
  it('reads back what start wrote', () => {
    expect(
      parseState(JSON.stringify({ state: 'abc', provider: 'facebook', audience: 'BRAND', next: '/brand/campaigns' })),
    ).toEqual({ state: 'abc', provider: 'facebook', audience: 'BRAND', next: '/brand/campaigns' })
  })

  it('defaults an unknown or missing audience to the creator form', () => {
    expect(parseState(JSON.stringify({ state: 'abc', provider: 'google' }))).toEqual({
      state: 'abc',
      provider: 'google',
      audience: 'PARTICIPANT',
      next: null,
    })
    expect(parseState(JSON.stringify({ state: 'a', provider: 'google', audience: 'OPS' }))?.audience).toBe('PARTICIPANT')
  })

  it('is null without a usable provider — the cookie names which flow is in progress', () => {
    expect(parseState(JSON.stringify({ state: 'abc' }))).toBeNull()
    expect(parseState(JSON.stringify({ state: 'abc', provider: 'apple' }))).toBeNull()
    expect(parseState(JSON.stringify({ state: 'abc', provider: 7 }))).toBeNull()
  })

  it('is null for a missing, truncated, empty or non-object cookie', () => {
    expect(parseState(undefined)).toBeNull()
    expect(parseState('')).toBeNull()
    expect(parseState('{"state":"abc"')).toBeNull()
    expect(parseState('null')).toBeNull()
    expect(parseState('"abc"')).toBeNull()
    expect(parseState(JSON.stringify({ state: '', provider: 'google' }))).toBeNull()
  })

  it('drops a non-string next rather than carrying it into safeNext', () => {
    expect(parseState(JSON.stringify({ state: 'a', provider: 'google', next: { evil: true } }))?.next).toBeNull()
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
