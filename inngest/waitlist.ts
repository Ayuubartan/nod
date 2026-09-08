/**
 * The waitlist game's clock (docs/13).
 *
 * The digest runs every quarter hour and sends at most one SMS per person per six
 * hours, never at night — the rules live in lib/waitlist-sms.ts, this is only the
 * tick. The daily boost hands a fixed number of random verified people +500 once a
 * day when ops has set `waitlist.dailyBoostCount` above zero; with the default 0 it
 * is a no-op, so nothing in the queue ever moves without a real cause.
 */

import { inngest } from '@/lib/events'
import { dailyBoost } from '@/lib/queue'
import { runDigest } from '@/lib/waitlist-sms'

export const waitlistDigest = inngest.createFunction(
  { id: 'waitlist-digest', name: 'Waitlist SMS digest' },
  { cron: '*/15 * * * *' },
  async ({ step }) => step.run('digest', () => runDigest()),
)

/** 11:00 UTC — early afternoon in Sweden, well outside quiet hours for the digest that follows. */
export const waitlistDailyBoost = inngest.createFunction(
  { id: 'waitlist-daily-boost', name: 'Waitlist daily boost' },
  { cron: '0 11 * * *' },
  async ({ step }) => {
    const boosted = await step.run('boost', () => dailyBoost())
    return { boosted }
  },
)
