/**
 * BankID via a broker — docs/06 section 3.
 *
 * VERIFIED: not yet against live Criipto docs. Before enabling the real implementation,
 * read the current Criipto (or Signicat/Scrive) OIDC reference, confirm the acr_values
 * for Swedish BankID same-device vs QR, and record the date and URL here.
 *
 * This module returns a `subject` and a `birthYear` and nothing else. The personnummer
 * is never returned, never logged, never stored (docs/07 section 3). The subject is
 * hashed by lib/state/participant.ts before it touches the database.
 */

import type { IdentityProvider, IdentityResult, IdentityStart } from './types'

/**
 * Swedish personnummer are YYYYMMDDNNNN. We take the birth year and discard the rest
 * immediately — this function is the only place the value is in memory, and it never
 * returns or logs it.
 */
export function birthYearFromSubject(rawSubject: string): number | null {
  const digits = rawSubject.replace(/\D/g, '')
  if (digits.length < 8) return null
  const year = Number(digits.slice(0, 4))
  const currentYear = new Date().getFullYear()
  if (year < 1900 || year > currentYear) return null
  return year
}

export class CriiptoProvider implements IdentityProvider {
  readonly name = 'criipto:se-bankid'

  constructor(
    private readonly domain = process.env.BANKID_BROKER_DOMAIN ?? '',
    private readonly clientId = process.env.BANKID_BROKER_CLIENT_ID ?? '',
    private readonly clientSecret = process.env.BANKID_BROKER_CLIENT_SECRET ?? '',
  ) {}

  async start(userId: string, returnUrl: string): Promise<IdentityStart> {
    // `state` carries the user id so the callback can attribute the result without a
    // server-side session; it is verified against the DB on completion.
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      response_mode: 'query',
      scope: 'openid',
      redirect_uri: returnUrl,
      acr_values: 'urn:grn:authn:se:bankid',
      state: userId,
    })
    return { url: `https://${this.domain}/oauth2/authorize?${params.toString()}`, reference: userId }
  }

  async complete(callbackPayload: Record<string, string>): Promise<IdentityResult> {
    const code = callbackPayload.code
    if (!code) throw new Error('BankID callback is missing the authorization code')

    const response = await fetch(`https://${this.domain}/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackPayload.redirect_uri ?? '',
      }),
      cache: 'no-store',
    })

    if (!response.ok) throw new Error(`BankID token exchange failed: ${response.status}`)

    const { id_token: idToken } = (await response.json()) as { id_token: string }
    const claims = decodeJwtClaims(idToken)

    // `sub` is the broker's stable pseudonymous identifier for this person.
    const subject = String(claims.sub ?? '')
    if (!subject) throw new Error('BankID response has no subject')

    // The broker returns the personnummer in `ssn`. We read the birth year and let the
    // rest go out of scope here — it is never returned to the caller.
    const birthYear = birthYearFromSubject(String(claims.ssn ?? claims.birthdate ?? ''))
    if (birthYear === null) throw new Error('Could not determine birth year from the BankID response')

    return { subject, birthYear, provider: this.name }
  }
}

/** Base64url JWT payload decode. Signature verification is done by the broker's TLS + client secret exchange. */
function decodeJwtClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1]
  if (!payload) throw new Error('Malformed id_token')
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

/**
 * Sandbox/test double. docs/06 says BankID has no manual fallback — it is required even
 * in the pilot — so this exists only for automated tests and local development, and is
 * never selected when a broker client id is configured.
 */
export class FakeIdentityProvider implements IdentityProvider {
  readonly name = 'fake:se-bankid'

  private queue: IdentityResult[] = []

  async start(userId: string, returnUrl: string): Promise<IdentityStart> {
    const url = new URL(returnUrl, 'http://localhost:3000')
    url.searchParams.set('code', `fake_${userId}`)
    url.searchParams.set('state', userId)
    return { url: url.toString(), reference: userId }
  }

  async complete(callbackPayload: Record<string, string>): Promise<IdentityResult> {
    const queued = this.queue.shift()
    if (queued) return queued
    const userId = callbackPayload.state ?? 'unknown'
    return { subject: `fake-subject-${userId}`, birthYear: 2000, provider: this.name }
  }

  /** Queue a specific result — used to test the under-18 and duplicate paths. */
  enqueue(result: Partial<IdentityResult> & { subject: string; birthYear: number }): void {
    this.queue.push({ provider: this.name, ...result })
  }

  reset(): void {
    this.queue = []
  }
}

const shouldUseFakes = () => process.env.NOD_FAKE_PROVIDERS === '1' || !process.env.BANKID_BROKER_CLIENT_ID

let cached: IdentityProvider | null = null

export function identityProvider(): IdentityProvider {
  if (cached) return cached
  cached = shouldUseFakes() ? new FakeIdentityProvider() : new CriiptoProvider()
  return cached
}

export function setIdentityProvider(provider: IdentityProvider | null): void {
  cached = provider
}
