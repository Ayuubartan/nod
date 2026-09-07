/**
 * Scrubbing — docs/08 security baseline and docs/06 section 8.
 *
 * These tests exist because the failure they guard against is silent: nothing breaks
 * when a personnummer reaches Sentry, it just sits in a third party's database forever.
 * So the assertions are deliberately paranoid, and several check the value scan rather
 * than the key list — the value scan is what catches the case nobody anticipated.
 */

import { describe, expect, it } from 'vitest'
import { REDACTED, isSensitiveKey, scrubString, scrubUrl, scrubValue } from '@/lib/scrub'
import { scrubEvent } from '@/sentry.shared'

describe('sensitive keys', () => {
  it('recognises the fields docs/06 names explicitly', () => {
    for (const key of ['swishNumber', 'accessToken', 'refreshToken', 'subjectHash', 'personnummer']) {
      expect(isSensitiveKey(key), `${key} should be sensitive`).toBe(true)
    }
  })

  it('matches regardless of casing or separator', () => {
    for (const key of ['SWISH_NUMBER', 'swish_number', 'Access-Token', 'ACCESSTOKEN', 'id_token']) {
      expect(isSensitiveKey(key), `${key} should be sensitive`).toBe(true)
    }
  })

  it('does not over-match ordinary fields', () => {
    for (const key of ['userId', 'placementId', 'views', 'campaignName', 'handle', 'city']) {
      expect(isSensitiveKey(key), `${key} should not be sensitive`).toBe(false)
    }
  })
})

describe('value scanning — the case the key list cannot cover', () => {
  it('redacts a personnummer buried in free text', () => {
    const message = 'BankID lookup failed for 199505054321 after two retries'
    const scrubbed = scrubString(message)

    expect(scrubbed).not.toContain('199505054321')
    expect(scrubbed).toContain(REDACTED)
    // The rest of the message survives, or the log is useless.
    expect(scrubbed).toContain('BankID lookup failed')
    expect(scrubbed).toContain('after two retries')
  })

  it('redacts every personnummer format a broker might return', () => {
    for (const value of ['199505054321', '19950505-4321', '950505-4321', '9505054321']) {
      expect(scrubString(`subject=${value}`), value).not.toContain(value)
    }
  })

  it('redacts a Swedish mobile number, which is what Swish pays', () => {
    for (const value of ['+46701234567', '0701234567', '070-123 45 67', '076 123 45 67']) {
      expect(scrubString(`paying ${value}`), value).not.toContain(value.replace(/\s/g, ''))
    }
  })

  it('redacts bearer tokens and provider credentials', () => {
    expect(scrubString('authorization: Bearer IGQVJYabc123def456ghi789')).not.toContain('IGQVJY')
    expect(scrubString('key sk_live_abcdefghijklmnop')).not.toContain('sk_live_abcdefghijklmnop')
    expect(scrubString('whsec_abcdefghijklmnopqrs')).not.toContain('whsec_abcdefghijklmnopqrs')
  })

  it('redacts a JWT, which is the shape a BankID id_token arrives in', () => {
    const jwt =
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxOTk1MDUwNTQzMjEiLCJzc24iOiIxOTk1MDUwNTQzMjEifQ.signaturepart'
    const scrubbed = scrubString(`id_token=${jwt}`)

    expect(scrubbed).not.toContain('eyJhbGciOiJSUzI1NiJ9')
    // The encoded payload contained a personnummer; none of it survives.
    expect(scrubbed).not.toContain('eyJzdWIi')
  })
})

describe('deep scrubbing', () => {
  it('redacts sensitive keys at any depth', () => {
    const scrubbed = scrubValue({
      userId: 'u1',
      account: { handle: 'anna', accessToken: 'IGQVJsecret', nested: { swishNumber: '+46701234567' } },
    })

    const dump = JSON.stringify(scrubbed)
    expect(dump).not.toContain('IGQVJsecret')
    expect(dump).not.toContain('+46701234567')
    // Non-sensitive context survives so the log is still worth reading.
    expect(dump).toContain('u1')
    expect(dump).toContain('anna')
  })

  it('scrubs values inside arrays', () => {
    const scrubbed = scrubValue({ rows: [{ swishNumber: '+46701234567' }, { note: 'ref 199505054321' }] })
    const dump = JSON.stringify(scrubbed)

    expect(dump).not.toContain('+46701234567')
    expect(dump).not.toContain('199505054321')
  })

  it('survives a circular reference rather than throwing', () => {
    const node: Record<string, unknown> = { swishNumber: '+46701234567' }
    node.self = node

    const scrubbed = scrubValue(node) as Record<string, unknown>
    expect(JSON.stringify(scrubbed)).not.toContain('+46701234567')
  })

  it('leaves primitives alone', () => {
    expect(scrubValue(42)).toBe(42)
    expect(scrubValue(true)).toBe(true)
    expect(scrubValue(null)).toBeNull()
  })
})

describe('URLs', () => {
  it('redacts a token in a query string', () => {
    const scrubbed = scrubUrl('https://graph.instagram.com/me?fields=id&access_token=IGQVJsecrettoken')

    expect(scrubbed).not.toContain('IGQVJsecrettoken')
    // The path and the harmless params still identify which call failed.
    expect(scrubbed).toContain('graph.instagram.com/me')
    expect(scrubbed).toContain('fields=id')
  })

  it('handles a malformed URL without throwing', () => {
    expect(() => scrubUrl('not a url 199505054321')).not.toThrow()
    expect(scrubUrl('not a url 199505054321')).not.toContain('199505054321')
  })
})

describe('Sentry beforeSend — docs/08 "configured before first deploy"', () => {
  it('strips cookies, headers and request bodies entirely', () => {
    const event = scrubEvent({
      message: 'boom',
      request: {
        url: 'https://nod.se/verify?code=abc',
        cookies: { session: 'secret-session' },
        headers: { authorization: 'Bearer IGQVJsecret' },
        data: { ssn: '199505054321' },
      },
    } as never)

    expect(event).not.toBeNull()
    expect(event!.request?.cookies).toBeUndefined()
    expect(event!.request?.headers).toBeUndefined()
    expect(event!.request?.data).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain('secret-session')
    expect(JSON.stringify(event)).not.toContain('199505054321')
  })

  it('reduces the user to an id — no email, no IP', () => {
    const event = scrubEvent({
      message: 'boom',
      user: { id: 'u1', email: 'anna@example.se', ip_address: '81.2.3.4', username: 'anna' },
    } as never)

    expect(event!.user).toEqual({ id: 'u1' })
    expect(JSON.stringify(event)).not.toContain('anna@example.se')
    expect(JSON.stringify(event)).not.toContain('81.2.3.4')
  })

  it('scrubs a personnummer out of an exception message', () => {
    const event = scrubEvent({
      exception: {
        values: [{ type: 'Error', value: 'Duplicate subject 199505054321 already registered' }],
      },
    } as never)

    expect(JSON.stringify(event)).not.toContain('199505054321')
    expect(JSON.stringify(event)).toContain('Duplicate subject')
  })

  it('drops the event entirely rather than sending something it could not scrub', () => {
    // A getter that throws is the shape of a proxied request object.
    const hostile = {
      message: 'boom',
      get request(): never {
        throw new Error('cannot read')
      },
    }

    expect(scrubEvent(hostile as never)).toBeNull()
  })
})
