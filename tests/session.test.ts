/** The signed session cookie: tamper-evident, expiring, never throwing on junk. */

import { describe, expect, it } from 'vitest'
import { decodeSession, encodeSession } from '@/lib/session'

const payload = { authId: 'u1', email: 'anna@example.se', exp: Math.floor(Date.now() / 1000) + 60 }

describe('session cookie', () => {
  it('round-trips a payload', () => {
    expect(decodeSession(encodeSession(payload))).toEqual(payload)
  })

  it('rejects a tampered body or signature', () => {
    const token = encodeSession(payload)
    const [body, sig] = token.split('.') as [string, string]
    const forged = Buffer.from(JSON.stringify({ ...payload, authId: 'someone-else' })).toString('base64url')
    expect(decodeSession(`${forged}.${sig}`)).toBeNull()
    expect(decodeSession(`${body}.${sig.slice(0, -2)}xx`)).toBeNull()
  })

  it('rejects an expired session', () => {
    const token = encodeSession({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 })
    expect(decodeSession(token)).toBeNull()
  })

  it('treats junk as no session', () => {
    for (const junk of ['', 'x', '.', 'a.b', 'not-base64.!!!', undefined, null]) {
      expect(decodeSession(junk)).toBeNull()
    }
  })
})
