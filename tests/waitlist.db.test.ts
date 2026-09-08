/**
 * Waitlist → account bridge (lib/waitlist.ts).
 *
 *   - an address that joined the waitlist gets its answers back in onboarding
 *   - a waitlist referral becomes an account referral once the referrer has an account
 *   - unknown addresses and unknown values are simply null
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, makeParticipant, resetDb } from './helpers/db'
import { prefillFromWaitlist } from '@/lib/waitlist'

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

function entry(email: string, extra: Partial<Parameters<typeof db.waitlistEntry.create>[0]['data']> = {}) {
  return db.waitlistEntry.create({
    data: {
      handle: '@anna.se',
      platform: 'INSTAGRAM',
      city: 'goteborg',
      ageBracket: '26-30',
      followersBracket: '1k-5k',
      email,
      referralCode: `W${email.length}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      consentAt: new Date(),
      ...extra,
    },
  })
}

describe('prefillFromWaitlist', () => {
  it('returns the waitlist answers for an address, matched case-insensitively', async () => {
    await entry('anna@example.se')
    expect(await prefillFromWaitlist('Anna@Example.se')).toEqual({
      city: 'goteborg',
      ageBracket: '26-30',
      handle: 'anna.se',
      referredByCode: null,
    })
  })

  it('is null for an address that never joined, and drops values onboarding cannot use', async () => {
    expect(await prefillFromWaitlist('nobody@example.se')).toBeNull()
    expect(await prefillFromWaitlist(null)).toBeNull()

    await entry('odd@example.se', { city: 'Berlin', ageBracket: '99', handle: '@' })
    expect(await prefillFromWaitlist('odd@example.se')).toMatchObject({ city: null, ageBracket: null, handle: null })
  })

  it('carries a waitlist referral over to the referrer’s account', async () => {
    const referrer = await entry('ref@example.se')
    await entry('new@example.se', { referredBy: referrer.referralCode })

    // Referrer has no account yet: nothing to attribute to.
    expect((await prefillFromWaitlist('new@example.se'))?.referredByCode).toBeNull()

    const { user } = await makeParticipant()
    await db.user.update({ where: { id: user.id }, data: { email: 'ref@example.se' } })
    expect((await prefillFromWaitlist('new@example.se'))?.referredByCode).toBe(user.referralCode)
  })
})
