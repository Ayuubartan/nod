/**
 * Scrubbing — docs/08 security baseline: "no BankID data in logs; Sentry scrubbing
 * configured before first deploy", and docs/06 section 8: "scrub swishNumber, tokens,
 * any BankID payload".
 *
 * This is the single implementation. Sentry uses it, the logger uses it, and both are
 * tested against the same fixtures, because a scrubber that only covers one of the two
 * paths is worse than none — it creates the belief that secrets are handled.
 *
 * The approach is deny-by-key plus a value scan. Key matching catches the fields we
 * know about; the value scan catches the ones we do not, which is the case that
 * actually matters — a personnummer arriving inside a free-text error string.
 */

export const REDACTED = '[redacted]'

/** Field names whose values never leave the process, wherever they appear. */
const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'swishnumber',
  'swish_number',
  'personnummer',
  'ssn',
  'nationalid',
  'national_id',
  'subject',
  'subjecthash',
  'subject_hash',
  'birthdate',
  'id_token',
  'idtoken',
  'client_secret',
  'clientsecret',
  'encryption_key',
  'signature',
  'privatekey',
  'private_key',
]

/**
 * Swedish personnummer: YYYYMMDDNNNN or YYMMDD-NNNN, with optional separator.
 *
 * Deliberately broad. A false positive redacts a number that looked like an identity
 * number; a false negative writes someone's personnummer to a third-party service.
 */
const PERSONNUMMER = /\b(?:19|20)?\d{6}[-+]?\d{4}\b/g

/**
 * Swedish mobile numbers, which are what Swish payouts key on.
 *
 * Anchored with a digit lookbehind rather than `\b`: a leading `+` is not a word
 * character, so `\b` never matches before `+46...` and the most common format would
 * have slipped through entirely.
 */
const SE_MOBILE = /(?<!\d)(?:\+46|0046|0)\s?7[0236]\s?-?\s?\d{3}\s?\d{2}\s?\d{2}(?!\d)/g

/** Bearer tokens and long opaque credentials in free text. */
const BEARER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi
const LONG_TOKEN = /\b(?:IGQ|EAA|sk_live_|sk_test_|whsec_)[A-Za-z0-9._-]{12,}/g

/** JWTs, which is the shape a BankID id_token arrives in. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

const isSensitiveKey = (key: string): boolean => {
  const normalised = key.toLowerCase().replace(/[^a-z_]/g, '')
  return SENSITIVE_KEYS.some((sensitive) => normalised.includes(sensitive.replace(/[^a-z_]/g, '')))
}

/** Redacts identity numbers, phone numbers and credentials found inside a string. */
export function scrubString(value: string): string {
  return value
    .replace(JWT, REDACTED)
    .replace(BEARER, REDACTED)
    .replace(LONG_TOKEN, REDACTED)
    .replace(PERSONNUMMER, REDACTED)
    .replace(SE_MOBILE, REDACTED)
}

/**
 * Deep-scrubs any value. Cycles are handled, because Sentry hands us request objects
 * that reference themselves.
 */
export function scrubValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return scrubString(value) as unknown as T
  if (value === null || typeof value !== 'object') return value

  if (seen.has(value as object)) return '[circular]' as unknown as T
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, seen)) as unknown as T
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : scrubValue(item, seen)
  }
  return out as unknown as T
}

/** Query strings carry tokens in `?access_token=`; strip them from any URL. */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(key)) parsed.searchParams.set(key, REDACTED)
    }
    return scrubString(parsed.toString())
  } catch {
    return scrubString(url)
  }
}

export { isSensitiveKey }
