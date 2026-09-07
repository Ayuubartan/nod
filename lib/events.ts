/**
 * The event vocabulary. Every state transition emits one; Inngest functions subscribe.
 *
 * Emission is intentionally fire-and-forget-after-commit: a failed emit is logged and
 * swallowed rather than rolling back a committed transition. The timeout jobs are
 * scheduled from `deadlineAt` columns as well as from events, so a lost event delays a
 * job but never loses money (see inngest/scheduled/sweep.ts).
 */

import { Inngest, EventSchemas } from 'inngest'
import { log } from './logger'

export type NodEventName =
  // campaign
  | 'campaign/submitted'
  | 'campaign/approved'
  | 'campaign/returned'
  | 'campaign/funded'
  | 'campaign/live'
  | 'campaign/filling'
  | 'campaign/exhausted'
  | 'campaign/expired'
  | 'campaign/paused'
  | 'campaign/reopened'
  | 'campaign/reconciling'
  | 'campaign/closed'
  | 'campaign/fill.threshold'
  // placement
  | 'placement/claimed'
  | 'placement/uploaded'
  | 'placement/positioned'
  | 'placement/generating'
  | 'placement/generated'
  | 'placement/generation.failed'
  | 'placement/participant.approved'
  | 'placement/brand.review'
  | 'placement/approved'
  | 'placement/published'
  | 'placement/hold.ended'
  | 'placement/verified'
  | 'placement/qualified'
  | 'placement/paid'
  | 'placement/rejected'
  | 'placement/expired'
  | 'placement/flagged'
  | 'placement/disclosure.fix.window'
  // participant
  | 'participant/onboarded'
  | 'participant/verified'
  | 'participant/active'
  | 'participant/flagged'
  | 'participant/suspended'
  | 'participant/removed'
  | 'participant/deletion.requested'
  // money
  | 'money/deposit.received'
  | 'money/payout.accrued'
  | 'money/payout.batch.exported'
  | 'money/payout.sent'
  | 'money/refunded'
  // accounts
  | 'account/connected'
  | 'account/disconnected'
  | 'account/token.refresh.failed'
  // referral
  | 'referral/qualified'
  // marketing
  | 'waitlist/joined'
  | 'brand/enquiry'

export type NodEvent = {
  name: NodEventName
  data: Record<string, unknown>
  /** Stable key so a redelivered event does not run a job twice. */
  id?: string
}

type Schemas = {
  [K in NodEventName]: { data: Record<string, unknown> }
}

export const inngest = new Inngest({
  id: 'nod',
  schemas: new EventSchemas().fromRecord<Schemas>(),
  eventKey: process.env.INNGEST_EVENT_KEY,
})

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'

/**
 * Without an event key there is nowhere to send events: every send would be a slow 401
 * against the cloud API, and the seed/scripts/server actions would each pay ~2s for it.
 * Set INNGEST_DEV=1 (with the Inngest dev server running) to deliver events locally.
 */
const hasSink = Boolean(process.env.INNGEST_EVENT_KEY) || process.env.INNGEST_DEV === '1'

/** Events captured in tests instead of being sent. */
export const capturedEvents: NodEvent[] = []

export async function emit(event: NodEvent): Promise<void> {
  if (isTest) {
    capturedEvents.push(event)
    return
  }
  if (!hasSink) return
  try {
    // The union of event names is wider than a single send() overload; the schema map
    // guarantees every member has the same `data` shape, so the cast is safe here.
    await inngest.send({ name: event.name, data: event.data, id: event.id } as Parameters<typeof inngest.send>[0])
  } catch (error) {
    // A committed transition must not be undone by a telemetry failure. The sweep job
    // picks up anything whose deadline passed without its event arriving.
    log.error('inngest emit failed', error, { event: event.name })
  }
}

export function clearCapturedEvents(): void {
  capturedEvents.length = 0
}

export function eventsOfType(name: NodEventName): NodEvent[] {
  return capturedEvents.filter((e) => e.name === name)
}
