/**
 * Email-code sign-in (lib/login.ts).
 *
 *   - a code is mailed, stored hashed, and signs the right person in
 *   - wrong guesses are counted and the code burns after five
 *   - a new request supersedes the old code; a used code cannot be replayed
 *   - brand sign-in requires an existing BrandUser; a new creator gets a fresh auth id
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, makeBrand, makeParticipant, resetDb } from './helpers/db'
import { sentMail } from '@/lib/email'
import { MAX_ATTEMPTS, requestCode, safeNext, verifyCode } from '@/lib/login'

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

/** The code only exists in the mail (and, without a provider, in the dev hint). */
function mailedCode(): string {
  const last = sentMail.at(-1)
  expect(last?.tag).toBe('login_code')
  const match = last!.subject.match(/^(\d{6}) /)
  expect(match).not.toBeNull()
  return match![1]!
}

describe('requestCode', () => {
  it('mails a six-digit code and stores only a hash of it', async () => {
    const result = await requestCode('Anna@Example.se ', 'PARTICIPANT', 'sv')
    expect(result.ok).toBe(true)
    const code = mailedCode()
    expect(result.ok && result.devCode).toBe(code)

    const row = await db.loginCode.findFirstOrThrow()
    expect(row.email).toBe('anna@example.se')
    expect(row.codeHash).not.toContain(code)
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('rejects a malformed address without touching the database', async () => {
    expect(await requestCode('not-an-email', 'PARTICIPANT', 'sv')).toEqual({ ok: false, error: 'invalidEmail' })
    expect(await db.loginCode.count()).toBe(0)
  })

  it('rate limits repeated requests for one address', async () => {
    for (let i = 0; i < 5; i++) expect((await requestCode('a@b.se', 'PARTICIPANT', 'sv')).ok).toBe(true)
    expect(await requestCode('a@b.se', 'PARTICIPANT', 'sv')).toEqual({ ok: false, error: 'rateLimited' })
  })

  it('supersedes an earlier code for the same address', async () => {
    await requestCode('a@b.se', 'PARTICIPANT', 'sv')
    const first = mailedCode()
    await requestCode('a@b.se', 'PARTICIPANT', 'sv')
    expect(await verifyCode('a@b.se', first, 'PARTICIPANT')).toMatchObject({ ok: false })
    expect(await verifyCode('a@b.se', mailedCode(), 'PARTICIPANT')).toMatchObject({ ok: true })
  })
})

describe('verifyCode', () => {
  it('signs an existing creator in and sends them to the app', async () => {
    const { user } = await makeParticipant({ avgViews30d: 450 })
    await db.user.update({ where: { id: user.id }, data: { email: 'anna@example.se' } })

    await requestCode('anna@example.se', 'PARTICIPANT', 'sv')
    const result = await verifyCode('anna@example.se', mailedCode(), 'PARTICIPANT')
    expect(result).toEqual({ ok: true, authId: user.authId, email: 'anna@example.se', next: '/campaigns' })
  })

  it('mints an auth id for a new creator and sends them to onboarding', async () => {
    await requestCode('new@example.se', 'PARTICIPANT', 'sv')
    const result = await verifyCode('new@example.se', mailedCode(), 'PARTICIPANT')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.next).toBe('/onboarding')
    expect(result.authId).toMatch(/^email_/)
    expect(await db.user.count()).toBe(0)
  })

  it('signs a brand user in, and refuses an address with no brand account', async () => {
    const brand = await makeBrand()
    const brandUser = await db.brandUser.findFirstOrThrow({ where: { brandId: brand.id } })

    await requestCode(brandUser.email.toUpperCase(), 'BRAND', 'en')
    expect(await verifyCode(brandUser.email, mailedCode(), 'BRAND')).toMatchObject({
      ok: true,
      authId: brandUser.authId,
      next: '/brand/campaigns',
    })

    await requestCode('stranger@example.se', 'BRAND', 'en')
    expect(await verifyCode('stranger@example.se', mailedCode(), 'BRAND')).toEqual({
      ok: false,
      error: 'noBrandAccount',
    })
  })

  it('never signs a brand user into the creator app', async () => {
    const brand = await makeBrand()
    const brandUser = await db.brandUser.findFirstOrThrow({ where: { brandId: brand.id } })
    await requestCode(brandUser.email, 'PARTICIPANT', 'sv')
    const result = await verifyCode(brandUser.email, mailedCode(), 'PARTICIPANT')
    // Unknown as a creator, so they would be a brand-new participant, never the brand identity.
    expect(result.ok && result.authId).not.toBe(brandUser.authId)
  })

  it('makes the OPS_EMAIL address the ops account, and upgrades an existing participant', async () => {
    const previous = process.env.OPS_EMAIL
    process.env.OPS_EMAIL = 'Ops@Example.se'
    try {
      await requestCode('ops@example.se', 'PARTICIPANT', 'sv')
      const first = await verifyCode('ops@example.se', mailedCode(), 'PARTICIPANT')
      expect(first).toMatchObject({ ok: true, next: '/ops' })
      const created = await db.user.findFirstOrThrow({ where: { email: 'ops@example.se' } })
      expect(created.role).toBe('OPS')

      // Signing in again reuses the same identity.
      await requestCode('ops@example.se', 'PARTICIPANT', 'sv')
      const again = await verifyCode('ops@example.se', mailedCode(), 'PARTICIPANT')
      expect(again.ok && again.authId).toBe(created.authId)

      // A participant who already had the address is promoted, not duplicated.
      process.env.OPS_EMAIL = 'anna@example.se'
      const { user } = await makeParticipant({ avgViews30d: 450 })
      await db.user.update({ where: { id: user.id }, data: { email: 'anna@example.se' } })
      await requestCode('anna@example.se', 'PARTICIPANT', 'sv')
      expect(await verifyCode('anna@example.se', mailedCode(), 'PARTICIPANT')).toMatchObject({
        ok: true,
        authId: user.authId,
        next: '/ops',
      })
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('OPS')
      expect(await db.user.count({ where: { email: 'anna@example.se' } })).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.OPS_EMAIL
      else process.env.OPS_EMAIL = previous
    }
  })

  it('counts wrong guesses and burns the code after the limit', async () => {
    await requestCode('a@b.se', 'PARTICIPANT', 'sv')
    const code = mailedCode()
    const wrong = code === '000000' ? '000001' : '000000'

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await verifyCode('a@b.se', wrong, 'PARTICIPANT')).toEqual({ ok: false, error: 'wrongCode' })
    }
    expect(await verifyCode('a@b.se', wrong, 'PARTICIPANT')).toEqual({ ok: false, error: 'tooManyAttempts' })
    // Even the right code is dead now.
    expect(await verifyCode('a@b.se', code, 'PARTICIPANT')).toEqual({ ok: false, error: 'tooManyAttempts' })
  })

  it('cannot be replayed once used, and ignores an expired code', async () => {
    await requestCode('a@b.se', 'PARTICIPANT', 'sv')
    const code = mailedCode()
    expect((await verifyCode('a@b.se', code, 'PARTICIPANT')).ok).toBe(true)
    expect(await verifyCode('a@b.se', code, 'PARTICIPANT')).toEqual({ ok: false, error: 'noCode' })

    await requestCode('b@b.se', 'PARTICIPANT', 'sv')
    await db.loginCode.updateMany({ where: { email: 'b@b.se' }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await verifyCode('b@b.se', mailedCode(), 'PARTICIPANT')).toEqual({ ok: false, error: 'noCode' })
  })
})

describe('safeNext', () => {
  it('allows only same-origin paths', () => {
    expect(safeNext('/onboarding', '/x')).toBe('/onboarding')
    expect(safeNext('//evil.example', '/x')).toBe('/x')
    expect(safeNext('https://evil.example', '/x')).toBe('/x')
    expect(safeNext('/\\evil.example', '/x')).toBe('/x')
    expect(safeNext(null, '/x')).toBe('/x')
  })
})
