/**
 * Encryption at rest and identity hashing — docs/07 section 3, docs/08 "Security baseline".
 *
 * Encrypted here: SocialAccount.accessToken / refreshToken, User.swishNumber.
 * Hashed here: the BankID broker's `subject`. The personnummer itself never reaches
 * this module — the broker returns a subject identifier and a birth year, and that is
 * all NOD ever sees or stores.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const PREFIX = 'v1'

let cachedKey: Buffer | null = null

function key(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
  }
  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}`)
  }
  cachedKey = buf
  return buf
}

/** AES-256-GCM. Output is "v1:<iv>:<tag>:<ciphertext>", all base64url. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':')
}

export function decrypt(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Malformed ciphertext')
  }
  const iv = Buffer.from(parts[1]!, 'base64url')
  const tag = Buffer.from(parts[2]!, 'base64url')
  const ciphertext = Buffer.from(parts[3]!, 'base64url')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed ciphertext')

  const decipher = createDecipheriv(ALGORITHM, key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** Decrypt, returning null instead of throwing — for display paths that can degrade. */
export function tryDecrypt(payload: string | null | undefined): string | null {
  if (!payload) return null
  try {
    return decrypt(payload)
  } catch {
    return null
  }
}

/**
 * sha256(subject + salt) — the only identity value NOD persists.
 *
 * The salt is a server secret, so the hash is not reversible by anyone who obtains the
 * database alone, and it is stable, so a returning person is still recognised and a
 * removed person can still be blocked from re-registering (docs/06 section 3).
 */
export function hashSubject(subject: string): string {
  const salt = process.env.BANKID_SUBJECT_SALT
  if (!salt || salt.length < 16) {
    throw new Error('BANKID_SUBJECT_SALT must be set to a long random string')
  }
  return createHash('sha256').update(`${subject}:${salt}`).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** URL-safe random token: referral codes, disclosure tokens, invite links. */
export function randomToken(bytes = 9): string {
  return randomBytes(bytes).toString('base64url')
}

/** Human-typable referral code: no ambiguous characters, 6 chars. */
export function referralCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buf = randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += alphabet[buf[i]! % alphabet.length]
  return out
}
