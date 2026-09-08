/**
 * The link in the mail — /queue?t=TOKEN — is opened by a route handler, because a
 * page cannot write cookies (this crashed production once). A good token sets the
 * cookie and proves the address; a bad one just lands on /queue.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, resetDb } from './helpers/db'
import { GET } from '@/app/(marketing)/queue/open/route'
import { joinQueue } from '@/lib/queue'
import { QUEUE_COOKIE, decodeQueueToken, queueLink } from '@/lib/queue-session'

beforeEach(resetDb)
afterAll(() => db.$disconnect())

async function entry() {
  const result = await joinQueue({
    email: 'anna@example.se',
    phone: null,
    city: 'stockholm',
    referredBy: null,
    smsConsent: false,
    marketingConsent: false,
    signupSource: 'test',
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    ip: '10.0.0.1',
  })
  if (!result.ok) throw new Error(result.error)
  return result.entry
}

describe('GET /queue/open', () => {
  it('sets the queue cookie, proves the address, and goes to /queue', async () => {
    const anna = await entry()
    const link = queueLink(anna.id, 'email').replace('/queue?t=', '/queue/open?t=')
    const response = await GET(new Request(link))

    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/queue')
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(new RegExp(`^${QUEUE_COOKIE}=`))
    expect(cookie).toContain('HttpOnly')
    const value = cookie.split(';')[0]!.slice(QUEUE_COOKIE.length + 1)
    expect(decodeQueueToken(value)).toMatchObject({ entryId: anna.id, via: 'cookie' })

    const after = await db.waitlistEntry.findUniqueOrThrow({ where: { id: anna.id } })
    expect(after.emailVerifiedAt).not.toBeNull()
    expect(after.verifiedAt).not.toBeNull()
  })

  it('an SMS link identifies but does not prove the address', async () => {
    const anna = await entry()
    const link = queueLink(anna.id, 'sms').replace('/queue?t=', '/queue/open?t=')
    await GET(new Request(link))
    const after = await db.waitlistEntry.findUniqueOrThrow({ where: { id: anna.id } })
    expect(after.emailVerifiedAt).toBeNull()
  })

  it('a forged or missing token sets nothing and still lands on /queue', async () => {
    for (const q of ['?t=forged.token', '']) {
      const response = await GET(new Request(`http://localhost:3000/queue/open${q}`))
      expect(response.status).toBe(302)
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(new URL(response.headers.get('location')!).pathname).toBe('/queue')
    }
  })
})
