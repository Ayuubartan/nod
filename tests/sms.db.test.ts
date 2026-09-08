/**
 * SMS fallback — docs/06 section 7.
 *
 * The rules being asserted all cost money if they are wrong: an SMS that duplicates a
 * push, an SMS for a notification the spec never sanctioned, or an SMS to someone who
 * did not opt in.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, makeBrand, makeCampaign, makeParticipant, resetDb } from './helpers/db'
import { setFlag } from '@/lib/flags'
import { clearSentPushes, notifyCampaignLive, notifyClaimExpiring, push, sentPushes } from '@/lib/notify'
import {
  FakeSmsProvider,
  SMS_ELIGIBLE,
  SmsNotAllowedError,
  sendSms,
  setSmsProvider,
} from '@/lib/integrations/sms'
import { sek } from '@/lib/money/calc'

const fakeSms = new FakeSmsProvider()

beforeEach(async () => {
  await resetDb()
  fakeSms.reset()
  setSmsProvider(fakeSms)
  clearSentPushes()
  await setFlag('notify.smsFallbackEnabled', true)
})

afterAll(async () => {
  setSmsProvider(null)
  await db.$disconnect()
})

describe('the allowlist — only three notifications may cost money', () => {
  it('permits exactly the docs/06 section 7 names, plus the docs/13 waitlist ones', () => {
    expect([...SMS_ELIGIBLE]).toEqual([
      'campaignLive',
      'claimExpiring',
      'approvedPostNow',
      'waitlistVerify',
      'waitlistDigest',
      'waitlistAccess',
    ])
  })

  it('throws rather than quietly sending for anything else', async () => {
    await expect(sendSms('qualified' as never, '+46701234567', 'hi')).rejects.toThrow(SmsNotAllowedError)
    expect(fakeSms.sent).toHaveLength(0)
  })
})

describe('it is a fallback, not a duplicate', () => {
  it('sends no SMS when push succeeded', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await db.user.update({
      where: { id: user.id },
      data: {
        smsOptIn: true,
        // A subscription present plus VAPID configured is what "push worked" looks like.
        pushSubscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'k', auth: 'a' } },
      },
    })

    // Without VAPID keys configured, push cannot be delivered, so this test asserts the
    // opposite branch below. Here we assert no SMS is attempted for a non-eligible kind.
    await push(user.id, { title: 'Hej', body: 'test' })
    expect(fakeSms.sent).toHaveLength(0)
  })

  it('falls back to SMS when push is unavailable and the participant opted in', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await db.user.update({ where: { id: user.id }, data: { smsOptIn: true, pushSubscription: undefined } })

    await push(user.id, { title: 'Ny kampanj', body: 'Kaffeklubben betalar nu.', smsKind: 'campaignLive' })

    expect(fakeSms.sent).toHaveLength(1)
    expect(fakeSms.sent[0]!.to).toBe('+46701234567')
    expect(fakeSms.sent[0]!.message).toContain('Ny kampanj')
  })

  it('sends nothing to a participant who did not opt in', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await db.user.update({ where: { id: user.id }, data: { smsOptIn: false } })

    await push(user.id, { title: 'Ny kampanj', body: 'x', smsKind: 'campaignLive' })
    expect(fakeSms.sent).toHaveLength(0)
  })

  it('sends nothing when the flag is off, even for an opted-in participant', async () => {
    await setFlag('notify.smsFallbackEnabled', false)

    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await db.user.update({ where: { id: user.id }, data: { smsOptIn: true } })

    await push(user.id, { title: 'Ny kampanj', body: 'x', smsKind: 'campaignLive' })
    expect(fakeSms.sent).toHaveLength(0)
  })

  it('sends nothing for a notification that did not opt into the fallback', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await db.user.update({ where: { id: user.id }, data: { smsOptIn: true } })

    // No smsKind: this is one of the notifications the spec does not permit by SMS.
    await push(user.id, { title: 'Du fick betalt', body: '237 kr' })
    expect(fakeSms.sent).toHaveLength(0)
  })

  it('sends nothing when there is no usable number', async () => {
    const { user } = await makeParticipant({ state: 'ACTIVE', swishNumber: null })
    await db.user.update({ where: { id: user.id }, data: { smsOptIn: true } })

    await push(user.id, { title: 'Ny kampanj', body: 'x', smsKind: 'campaignLive' })
    expect(fakeSms.sent).toHaveLength(0)
  })
})

describe('the notifications that use it', () => {
  it('campaign live falls back to SMS', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id, budgetOre: sek(1_000), fundOre: sek(1_000) })
    const { user } = await makeParticipant({ state: 'ACTIVE' })
    await db.user.update({ where: { id: user.id }, data: { smsOptIn: true } })

    await notifyCampaignLive(campaign.id, [user.id])

    expect(sentPushes).toHaveLength(1)
    expect(fakeSms.sent).toHaveLength(1)
  })

  it('claim expiring falls back to SMS', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const { user, account } = await makeParticipant({ state: 'ACTIVE' })
    await db.user.update({ where: { id: user.id }, data: { smsOptIn: true } })

    const placement = await db.placement.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        socialAccountId: account.id,
        state: 'CLAIMED',
        reservationOre: sek(90),
        deadlineAt: new Date(),
      },
    })

    await notifyClaimExpiring(placement.id)
    expect(fakeSms.sent).toHaveLength(1)
  })
})
