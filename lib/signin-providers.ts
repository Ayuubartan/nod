/**
 * Sign-in provider adapters — Google and Facebook, spoken to directly.
 *
 * DECISION: direct OAuth, not Supabase Auth as a broker. This project's database moved
 * to Neon, so Supabase would have been a whole service carried for one feature, plus a
 * second redirect hop and a second exact-match allowlist to get wrong. The repo already
 * talks OAuth directly for Instagram and TikTok (lib/integrations/social.ts); this is
 * the same shape. Supersedes the broker shipped in ab9cd78 the same day — see docs/11.
 *
 * Facebook Login runs on the **same Meta app** as the Instagram connection, so
 * `META_APP_ID`/`META_APP_SECRET` are reused rather than duplicated. Only Google adds
 * new credentials.
 *
 * Apple is deliberately absent: it needs a paid developer account and a client secret
 * that is an ES256 JWT to be regenerated every six months. It can be added here as a
 * third adapter when that is worth doing.
 *
 * What an adapter returns is the minimum to sign someone in: a stable provider id, a
 * verified address, and the display name. **Read-only, no write scopes** (CLAUDE.md
 * rule 6) — `openid email profile` and `public_profile email` and nothing else.
 */

export type SignInProvider = 'google' | 'facebook'

export type ProviderProfile = {
  providerUserId: string
  email: string
  emailVerified: boolean
  name: string | null
}

export type SignInAdapter = {
  /** Where to send the browser. `state` is round-tripped and checked on the way back. */
  authUrl(args: { state: string; redirectUri: string }): string
  /** Swap the callback code for the profile. Throws on any provider-side failure. */
  exchange(args: { code: string; redirectUri: string }): Promise<ProviderProfile>
  /** Both halves of the credential pair, or this provider cannot be offered. */
  configured(): boolean
}

async function postForm(url: string, body: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  if (!response.ok) throw new Error(`token exchange failed: ${response.status}`)
  return response.json()
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`profile fetch failed: ${response.status}`)
  return response.json()
}

// ------------------------------------------------------------------ Google

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo'

export const googleAdapter: SignInAdapter = {
  configured: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),

  authUrl: ({ state, redirectUri }) => {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      // Online only: NOD has no reason to act for someone while they are away, so it
      // never asks for a refresh token.
      access_type: 'online',
      // Someone signing in to a marketplace may well have several Google accounts and
      // needs to choose; silent reuse of the last one is a support ticket.
      prompt: 'select_account',
    })
    return `${GOOGLE_AUTH}?${params.toString()}`
  },

  exchange: async ({ code, redirectUri }) => {
    const token = (await postForm(GOOGLE_TOKEN, {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    })) as { access_token?: string }
    if (!token.access_token) throw new Error('no access token from Google')

    // DECISION: read the userinfo endpoint rather than decode the id_token. The token
    // came straight from Google's token endpoint over TLS in a request we made, so the
    // signature check a JWT library would do adds a dependency and a key-rotation
    // concern without adding a fact we do not already have.
    const profile = (await getJson(`${GOOGLE_USERINFO}?access_token=${encodeURIComponent(token.access_token)}`)) as {
      sub?: string
      email?: string
      email_verified?: boolean | string
      name?: string
    }
    if (!profile.sub) throw new Error('no subject from Google')

    return {
      providerUserId: profile.sub,
      email: profile.email ?? '',
      emailVerified: profile.email_verified === true || profile.email_verified === 'true',
      name: profile.name?.trim() || null,
    }
  },
}

// ---------------------------------------------------------------- Facebook

const GRAPH_VERSION = 'v21.0'
const FB_AUTH = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`
const FB_TOKEN = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
const FB_ME = `https://graph.facebook.com/${GRAPH_VERSION}/me`

export const facebookAdapter: SignInAdapter = {
  // The same Meta app as the Instagram connection (lib/integrations/instagram.ts);
  // Facebook Login is a second product on it, not a second app.
  configured: () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),

  authUrl: ({ state, redirectUri }) => {
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'public_profile,email',
      state,
    })
    return `${FB_AUTH}?${params.toString()}`
  },

  exchange: async ({ code, redirectUri }) => {
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID ?? '',
      client_secret: process.env.META_APP_SECRET ?? '',
      redirect_uri: redirectUri,
      code,
    })
    const token = (await getJson(`${FB_TOKEN}?${params.toString()}`)) as { access_token?: string }
    if (!token.access_token) throw new Error('no access token from Facebook')

    const profile = (await getJson(
      `${FB_ME}?fields=id,name,email&access_token=${encodeURIComponent(token.access_token)}`,
    )) as { id?: string; name?: string; email?: string }
    if (!profile.id) throw new Error('no id from Facebook')

    return {
      providerUserId: profile.id,
      // Facebook only returns an address it has itself confirmed, and omits the field
      // entirely otherwise — so a present address is a verified one. An absent address
      // (the person registered by phone, or declined the permission) falls through to
      // `socialNoEmail`, which tells them to use an email code instead.
      email: profile.email ?? '',
      emailVerified: Boolean(profile.email),
      name: profile.name?.trim() || null,
    }
  },
}

const ADAPTERS: Record<SignInProvider, SignInAdapter> = {
  google: googleAdapter,
  facebook: facebookAdapter,
}

export function adapterFor(provider: SignInProvider): SignInAdapter {
  return ADAPTERS[provider]
}
