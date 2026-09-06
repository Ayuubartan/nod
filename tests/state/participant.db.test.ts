/**
 * Participant lifecycle against the database — docs/09 M1 acceptance criteria.
 *
 * Includes the three BankID cases the build plan names explicitly: happy path,
 * under-18 rejection, and a second user presenting the same subject.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { auditFor, db, makeBrand, makeCampaign, makeParticipant, resetDb } from '../helpers/db'
import { hashSubject, referralCode } from '@/lib/crypto'
import { TransitionError } from '@/lib/state/transition'
import {
  activate,
  addStrike,
  clearFlag,
  flag,
  IdentityError,
  onboard,
  remove,
  restore,
  signUp,
  suspend,
  verifyIdentity,
} from '@/lib/state/participant'
import { claim, ClaimError } from '@/lib/state/placement'

const OPS = { kind: 'OPS' as const, id: 'ops-1' }
const SELF = { kind: 'PARTICIPANT' as const, id: 'self' }

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

describe('sign up', () => {
  it('creates a participant in SIGNED_UP with a wallet and a referral code', async () => {
    const { id } = await signUp({ authId: 'auth-1', email: 'a@example.se', city: 'stockholm' }, referralCode)

    const user = await db.user.findUniqueOrThrow({ where: { id }, include: { wallet: true } })
    expect(user.state).toBe('SIGNED_UP')
    expect(user.wallet).not.toBeNull()
    expect(user.referralCode).toHaveLength(6)

    const audit = await auditFor('Participant', id)
    expect(audit[0]!.event).toBe('SIGN_UP')
  })

  it('attributes a referral when the code exists, and ignores one that does not', async () => {
    const referrer = await signUp({ authId: 'auth-ref' }, () => 'REF123')

    const attributed = await signUp({ authId: 'auth-2', referredByCode: 'REF123' }, referralCode)
    const referral = await db.referral.findUnique({ where: { referredId: attributed.id } })
    expect(referral?.referrerId).toBe(referrer.id)

    const unattributed = await signUp({ authId: 'auth-3', referredByCode: 'NOPE99' }, referralCode)
    const none = await db.referral.findUnique({ where: { referredId: unattributed.id } })
    expect(none).toBeNull()
  })
})

describe('onboarding', () => {
  it('refuses to onboard without an account, terms, the quiz, or a payout number', async () => {
    const { id } = await signUp({ authId: 'auth-onboard' }, referralCode)

    await expect(onboard(id, SELF)).rejects.toThrow(/NO_ACCOUNT|social account/)

    await db.socialAccount.create({
      data: {
        userId: id,
        platform: 'INSTAGRAM',
        handle: 'x',
        platformUserId: 'ig_onboard',
        tier: 'CONNECTED_SCREENSHOT',
        followers: 500,
        avgViews30d: 300,
      },
    })
    await expect(onboard(id, SELF)).rejects.toThrow(/NO_TERMS|Terms/)

    await db.user.update({ where: { id }, data: { termsAcceptedAt: new Date() } })
    await expect(onboard(id, SELF)).rejects.toThrow(/NO_QUIZ|disclosure/)

    await db.user.update({ where: { id }, data: { disclosureQuizAt: new Date() } })
    await expect(onboard(id, SELF)).rejects.toThrow(/NO_PAYOUT|payout/)

    await db.user.update({ where: { id }, data: { swishNumber: 'encrypted' } })
    await expect(onboard(id, SELF)).resolves.toBe('ONBOARDED')
  })
})

describe('BankID verification — docs/09 M1 acceptance', () => {
  it('happy path: ONBOARDED -> VERIFIED, storing only the hash and the birth year', async () => {
    const { user } = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })

    const state = await verifyIdentity(user.id, {
      subject: '199001011234',
      birthYear: 1990,
      provider: 'criipto:se-bankid',
    })

    expect(state).toBe('VERIFIED')

    const identity = await db.identity.findUniqueOrThrow({ where: { userId: user.id } })
    expect(identity.birthYear).toBe(1990)
    expect(identity.subjectHash).toBe(hashSubject('199001011234'))
    // The raw subject must never be recoverable from the row.
    expect(identity.subjectHash).not.toContain('199001011234')
    expect(JSON.stringify(identity)).not.toContain('199001011234')
  })

  it('rejects an under-18 participant and writes nothing', async () => {
    const { user } = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })
    const thisYear = new Date().getFullYear()

    await expect(
      verifyIdentity(user.id, { subject: 'young', birthYear: thisYear - 17, provider: 'test' }),
    ).rejects.toThrow(IdentityError)

    const identity = await db.identity.findUnique({ where: { userId: user.id } })
    expect(identity).toBeNull()

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.state).toBe('ONBOARDED')
  })

  it('accepts someone who turns 18 this year', async () => {
    const { user } = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })
    const thisYear = new Date().getFullYear()

    await expect(
      verifyIdentity(user.id, { subject: 'just-18', birthYear: thisYear - 18, provider: 'test' }),
    ).resolves.toBe('VERIFIED')
  })

  it('rejects a second user presenting the same BankID subject', async () => {
    const first = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })
    const second = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })

    await verifyIdentity(first.user.id, { subject: 'same-person', birthYear: 1995, provider: 'test' })

    await expect(
      verifyIdentity(second.user.id, { subject: 'same-person', birthYear: 1995, provider: 'test' }),
    ).rejects.toThrow(/already has a NOD account/)
  })

  it('still blocks re-registration after removal — the hash is retained', async () => {
    const { user } = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })
    await verifyIdentity(user.id, { subject: 'removed-person', birthYear: 1995, provider: 'test' })
    await remove(user.id, 'self-delete', OPS)

    const identity = await db.identity.findUnique({ where: { userId: user.id } })
    expect(identity).not.toBeNull()

    const newcomer = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })
    await expect(
      verifyIdentity(newcomer.user.id, { subject: 'removed-person', birthYear: 1995, provider: 'test' }),
    ).rejects.toThrow(/already has a NOD account/)
  })

  it('creates the wallet on verification', async () => {
    const { user } = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })
    await db.wallet.deleteMany({ where: { userId: user.id } })

    await verifyIdentity(user.id, { subject: 'wallet-person', birthYear: 1995, provider: 'test' })

    const wallet = await db.wallet.findUnique({ where: { userId: user.id } })
    expect(wallet).not.toBeNull()
  })
})

describe('illegal transitions throw', () => {
  it('cannot verify a SIGNED_UP participant', async () => {
    const { id } = await signUp({ authId: 'auth-illegal' }, referralCode)
    await expect(
      verifyIdentity(id, { subject: 's', birthYear: 1990, provider: 'test' }),
    ).rejects.toThrow(TransitionError)
  })

  it('cannot activate before verifying', async () => {
    const { user } = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })
    await expect(activate(user.id)).rejects.toThrow(TransitionError)
  })

  it('cannot clear a flag on someone who is not flagged', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await expect(clearFlag(user.id, 'nope', OPS)).rejects.toThrow(TransitionError)
  })

  it('cannot do anything to a removed participant', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await remove(user.id, 'gone', OPS)

    await expect(flag(user.id, 'x', OPS)).rejects.toThrow(TransitionError)
    await expect(suspend(user.id, 'x', OPS)).rejects.toThrow(TransitionError)
    await expect(restore(user.id, 'x')).rejects.toThrow(TransitionError)
  })
})

describe('strikes — docs/03 section 3', () => {
  it('suspends on one serious strike', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })

    const result = await addStrike({ userId: user.id, severity: 'SERIOUS', reason: 'DELETED_EARLY' })

    expect(result.suspended).toBe(true)
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.state).toBe('SUSPENDED')
  })

  it('flags on the first minor strike and suspends on the third', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })

    const first = await addStrike({ userId: user.id, severity: 'MINOR', reason: 'NO_DISCLOSURE' })
    expect(first.flagged).toBe(true)
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).state).toBe('FLAGGED')

    await addStrike({ userId: user.id, severity: 'MINOR', reason: 'late' })
    const third = await addStrike({ userId: user.id, severity: 'MINOR', reason: 'late' })

    expect(third.suspended).toBe(true)
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).state).toBe('SUSPENDED')
  })

  it('records every strike with its reason for the ops console', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await addStrike({ userId: user.id, severity: 'MINOR', reason: 'NO_DISCLOSURE', placementId: 'p1' })

    const strikes = await db.strike.findMany({ where: { userId: user.id } })
    expect(strikes).toHaveLength(1)
    expect(strikes[0]!.reason).toBe('NO_DISCLOSURE')
    expect(strikes[0]!.placementId).toBe('p1')
  })
})

describe('flag, clear and suspend gate claiming', () => {
  it('stops a flagged participant claiming, and lets them again once cleared', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant({ state: 'ACTIVE' })

    await flag(user.id, 'suspicious velocity', OPS)
    await expect(
      claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id }),
    ).rejects.toThrow(ClaimError)

    await clearFlag(user.id, 'reviewed, fine', OPS)
    await expect(
      claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id }),
    ).resolves.toHaveProperty('id')
  })

  it('records the ops reason on every flag and suspension', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await flag(user.id, 'velocity anomaly', OPS)

    const audit = await auditFor('Participant', user.id)
    const flagEntry = audit.find((a) => a.event === 'FLAG')
    expect(flagEntry?.reason).toBe('velocity anomaly')
    expect(flagEntry?.actor).toBe('ops:ops-1')
  })
})

describe('suspension restore', () => {
  it('restores a suspended participant to ACTIVE', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await suspend(user.id, 'strike', OPS)

    await restore(user.id, 'Suspension period elapsed')

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.state).toBe('ACTIVE')
  })
})

describe('no personnummer anywhere — docs/09 M1 acceptance', () => {
  it('leaves no trace of the raw subject in any table after a full verification', async () => {
    const personnummer = '199505054321'
    const { user } = await makeParticipant({ state: 'ONBOARDED', withIdentity: false })
    await verifyIdentity(user.id, { subject: personnummer, birthYear: 1995, provider: 'criipto:se-bankid' })

    const [identities, users, audits] = await Promise.all([
      db.identity.findMany(),
      db.user.findMany(),
      db.auditLog.findMany(),
    ])

    const dump = JSON.stringify({ identities, users, audits })
    expect(dump).not.toContain(personnummer)
    expect(dump).not.toContain('19950505')
  })
})
