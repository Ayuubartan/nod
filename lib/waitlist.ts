/**
 * The bridge between the waitlist and an account.
 *
 * Joining the waitlist and creating an account used to be two unrelated forms: the
 * waitlist stored a handle, city and age, and onboarding asked for all of it again
 * under a fresh identity. Now the waitlist entry is the first half of onboarding —
 * whoever signs in with the same address gets their answers back, and a waitlist
 * referral carries over to the account of the person who referred them.
 */

import { prisma } from './db'

export type WaitlistPrefill = {
  city: string | null
  ageBracket: string | null
  handle: string | null
  /** The referrer's *account* referral code, when the referrer has an account. */
  referredByCode: string | null
}

const CITIES = ['stockholm', 'goteborg', 'malmo', 'uppsala', 'other']
const AGE_BRACKETS = ['18-20', '21-25', '26-30', '31+']

/** What the waitlist already knows about this address, or null when it never joined. */
export async function prefillFromWaitlist(email: string | null | undefined): Promise<WaitlistPrefill | null> {
  if (!email) return null
  const entry = await prisma.waitlistEntry.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { city: true, ageBracket: true, handle: true, referredBy: true },
  })
  if (!entry) return null

  // DECISION: a waitlist referral code belongs to a WaitlistEntry, an account referral
  // code to a User. They meet through the referrer's email: if the person who shared
  // the link has since made an account, the new creator is attributed to it (docs/01
  // section 7). If not, the attribution is simply lost — no phantom accounts.
  let referredByCode: string | null = null
  if (entry.referredBy) {
    const referrer = await prisma.waitlistEntry.findUnique({
      where: { referralCode: entry.referredBy },
      select: { email: true },
    })
    if (referrer) {
      const referrerUser = await prisma.user.findFirst({
        where: { email: { equals: referrer.email, mode: 'insensitive' }, deletedAt: null },
        select: { referralCode: true },
      })
      referredByCode = referrerUser?.referralCode ?? null
    }
  }

  return {
    city: CITIES.includes(entry.city) ? entry.city : null,
    ageBracket: AGE_BRACKETS.includes(entry.ageBracket) ? entry.ageBracket : null,
    handle: entry.handle.replace(/^@/, '') || null,
    referredByCode,
  }
}
