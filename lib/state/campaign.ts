/**
 * Campaign lifecycle — docs/03 section 2.
 *
 *  DRAFT -> SUBMITTED -> AWAITING_FUNDS -> FUNDED -> LIVE -> FILLING
 *             |  \                                              |
 *             |   RETURNED -> DRAFT                    EXHAUSTED / EXPIRED
 *             |                                                 |
 *           PAUSED -------------------------------------> RECONCILING -> CLOSED
 */

import type { CampaignState, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { campaignBalance } from '@/lib/money/balances'
import { creditTermsFee, deposit, refund, rollover } from '@/lib/money/ledger'
import { DEFAULTS, LIMITS, TIMEOUT_MS, DROP_SCHEDULE } from '@/lib/money/rates'
import { creditTermsFeeOre } from '@/lib/money/calc'
import {
  GuardError,
  runTransition,
  SYSTEM,
  type ActorRef,
  type TransitionTable,
  type Tx,
} from './transition'

export type CampaignEvent =
  | 'SUBMIT'
  | 'APPROVE'
  | 'RETURN'
  | 'RESUBMIT'
  | 'FUND'
  | 'GO_LIVE'
  | 'FIRST_CLAIM'
  | 'EXHAUST'
  | 'EXPIRE'
  | 'REOPEN'
  | 'PAUSE'
  | 'RECONCILE'
  | 'CLOSE'

export const CAMPAIGN_TABLE: TransitionTable<CampaignState, CampaignEvent> = {
  DRAFT: { SUBMIT: 'SUBMITTED' },
  SUBMITTED: { APPROVE: 'AWAITING_FUNDS', RETURN: 'RETURNED' },
  RETURNED: { RESUBMIT: 'SUBMITTED' },
  // 14-day expiry on an unfunded campaign sends it back to the builder (docs/03).
  AWAITING_FUNDS: { FUND: 'FUNDED', EXPIRE: 'DRAFT' },
  FUNDED: { GO_LIVE: 'LIVE', PAUSE: 'PAUSED' },
  LIVE: { FIRST_CLAIM: 'FILLING', EXPIRE: 'EXPIRED', PAUSE: 'PAUSED', EXHAUST: 'EXHAUSTED' },
  FILLING: { EXHAUST: 'EXHAUSTED', EXPIRE: 'EXPIRED', PAUSE: 'PAUSED' },
  // Auto-reopen once if more than 20% of reservations release (docs/03, edge case 1).
  EXHAUSTED: { REOPEN: 'FILLING', RECONCILE: 'RECONCILING' },
  EXPIRED: { RECONCILE: 'RECONCILING' },
  // A pause is immediate; open claims are honoured and paid, then it reconciles.
  PAUSED: { RECONCILE: 'RECONCILING' },
  RECONCILING: { CLOSE: 'CLOSED' },
  CLOSED: {},
}

/** States in which a participant may claim — docs/03 section 2. */
export const CLAIMABLE_STATES: CampaignState[] = ['LIVE', 'FILLING']

export function isClaimable(state: CampaignState): boolean {
  return CLAIMABLE_STATES.includes(state)
}

const load = (campaignId: string) => async (tx: Tx) =>
  tx.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: {
      id: true,
      state: true,
      brandId: true,
      budget: true,
      name: true,
      endsAt: true,
      goLiveAt: true,
      reopenedAt: true,
      creditTermsFeeBps: true,
      fundedVia: true,
    },
  })

// ---------------------------------------------------------------- builder

/** Next Friday 18:00 Europe/Stockholm — the default drop (docs/02 B1, docs/03). */
export function nextDropAt(from: Date = new Date()): Date {
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(DROP_SCHEDULE.minute)
  d.setHours(DROP_SCHEDULE.hour)
  const daysAhead = (DROP_SCHEDULE.weekday - d.getDay() + 7) % 7
  d.setDate(d.getDate() + daysAhead)
  if (d <= from) d.setDate(d.getDate() + 7)
  return d
}

export async function submit(campaignId: string, actor: ActorRef): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'SUBMIT',
    actor,
    load: load(campaignId),
    guard: async (tx) => {
      const c = await tx.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: {
          budget: true,
          perPlacementMax: true,
          disclosureText: true,
          endsAt: true,
          payoutTemplate: true,
          assets: { select: { id: true } },
        },
      })
      if (c.budget <= 0) throw new GuardError('NO_BUDGET', 'Set a budget before submitting')
      if (!c.payoutTemplate) throw new GuardError('NO_TEMPLATE', 'Pick a payout template')
      if (c.assets.length === 0) throw new GuardError('NO_ASSETS', 'Upload at least one asset')
      if (!c.endsAt) throw new GuardError('NO_PERIOD', 'Set a campaign period')
      if (c.perPlacementMax <= 0) throw new GuardError('NO_MAX', 'Set a per-placement maximum')
      assertDisclosureGuard(c.disclosureText)
    },
    apply: async (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: { state: 'SUBMITTED', submittedAt: new Date(), returnedNotes: null },
      }),
    events: () => [{ name: 'campaign/submitted', data: { campaignId } }],
  })
  return result.to as CampaignState
}

export async function resubmit(campaignId: string, actor: ActorRef): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'RESUBMIT',
    actor,
    load: load(campaignId),
    apply: async (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: { state: 'SUBMITTED', submittedAt: new Date(), returnedNotes: null },
      }),
    events: () => [{ name: 'campaign/submitted', data: { campaignId, resubmitted: true } }],
  })
  return result.to as CampaignState
}

/**
 * Disclosure guard — docs/07 section 1. Swedish audiences require the word Reklam or
 * Annons at the start; the brand may edit the wording but cannot remove the disclosure.
 */
export function assertDisclosureGuard(text: string): void {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new GuardError('NO_DISCLOSURE_TEXT', 'Disclosure text is required')
  const start = trimmed.toLowerCase()
  const okSwedish = start.startsWith('reklam') || start.startsWith('annons')
  const okEnglish = start.startsWith('ad ') || start.startsWith('ad–') || start.startsWith('ad-')
  if (!okSwedish && !okEnglish) {
    throw new GuardError(
      'BAD_DISCLOSURE',
      'Disclosure must start with "Reklam" or "Annons" for Swedish audiences',
    )
  }
}

// ---------------------------------------------------------------- ops review

export async function approve(campaignId: string, actor: ActorRef): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'APPROVE',
    actor,
    load: load(campaignId),
    apply: async (tx) => tx.campaign.update({ where: { id: campaignId }, data: { state: 'AWAITING_FUNDS' } }),
    events: () => [{ name: 'campaign/approved', data: { campaignId } }],
  })
  return result.to as CampaignState
}

export async function returnToBrand(campaignId: string, notes: string, actor: ActorRef): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'RETURN',
    actor,
    reason: notes,
    load: load(campaignId),
    apply: async (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { state: 'RETURNED', returnedNotes: notes } }),
    events: () => [{ name: 'campaign/returned', data: { campaignId, notes } }],
  })
  return result.to as CampaignState
}

// ---------------------------------------------------------------- funding

/**
 * AWAITING_FUNDS -> FUNDED, on a Stripe deposit or an ops-approved invoice.
 *
 * The take rate is snapshotted onto the PayoutTemplate here and never changes again
 * (docs/05: "Snapshotted on PayoutTemplate at funding; never changes mid-campaign").
 */
export async function fund(
  campaignId: string,
  args: { amountOre: number; externalRef?: string; via: 'card' | 'invoice' },
  actor: ActorRef = SYSTEM,
): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'FUND',
    actor,
    payload: { amountOre: args.amountOre, via: args.via },
    load: load(campaignId),
    guard: (_tx, campaign) => {
      if (args.amountOre < (campaign.budget as number)) {
        throw new GuardError(
          'UNDERFUNDED',
          `Deposit ${args.amountOre} is less than the campaign budget ${campaign.budget}`,
        )
      }
    },
    apply: async (tx, { entity }) => {
      await deposit(tx, campaignId, args.amountOre, args.externalRef)

      if (args.via === 'invoice') {
        const feeBps = (entity.creditTermsFeeBps as number) || DEFAULTS.creditTermsFeeBps
        await creditTermsFee(tx, campaignId, creditTermsFeeOre(args.amountOre, feeBps))
      }

      // Freeze the take rate for the life of the campaign.
      await tx.payoutTemplate.updateMany({
        where: { campaignId },
        data: { takeRateBps: DEFAULTS.takeRateBps },
      })

      return tx.campaign.update({
        where: { id: campaignId },
        data: { state: 'FUNDED', fundedAt: new Date(), fundedVia: args.via },
      })
    },
    events: () => [
      { name: 'campaign/funded', data: { campaignId, amountOre: args.amountOre } },
      { name: 'money/deposit.received', data: { campaignId, amountOre: args.amountOre } },
    ],
  })
  return result.to as CampaignState
}

// ---------------------------------------------------------------- running

export async function goLive(campaignId: string, actor: ActorRef = SYSTEM): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'GO_LIVE',
    actor,
    load: load(campaignId),
    apply: async (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { state: 'LIVE', liveAt: new Date() } }),
    events: () => [{ name: 'campaign/live', data: { campaignId } }],
  })
  return result.to as CampaignState
}

/** LIVE -> FILLING on the first claim. Idempotent: a no-op once already FILLING. */
export async function markFilling(campaignId: string, tx?: Tx): Promise<void> {
  const client = tx ?? prisma
  const campaign = await client.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { state: true },
  })
  if (campaign.state !== 'LIVE') return

  await runTransition(
    {
      entity: 'Campaign',
      entityId: campaignId,
      table: CAMPAIGN_TABLE,
      event: 'FIRST_CLAIM',
      actor: SYSTEM,
      load: load(campaignId),
      apply: async (inner) => inner.campaign.update({ where: { id: campaignId }, data: { state: 'FILLING' } }),
      events: () => [{ name: 'campaign/filling', data: { campaignId } }],
    },
    tx,
  )
}

export async function exhaust(campaignId: string, actor: ActorRef = SYSTEM, tx?: Tx): Promise<CampaignState> {
  const result = await runTransition(
    {
      entity: 'Campaign',
      entityId: campaignId,
      table: CAMPAIGN_TABLE,
      event: 'EXHAUST',
      actor,
      load: load(campaignId),
      apply: async (inner) =>
        inner.campaign.update({ where: { id: campaignId }, data: { state: 'EXHAUSTED', exhaustedAt: new Date() } }),
      events: () => [{ name: 'campaign/exhausted', data: { campaignId } }],
    },
    tx,
  )
  return result.to as CampaignState
}

export async function expire(campaignId: string, actor: ActorRef = SYSTEM): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'EXPIRE',
    actor,
    load: load(campaignId),
    apply: async (tx, { to }) =>
      tx.campaign.update({
        where: { id: campaignId },
        // AWAITING_FUNDS expiry goes back to DRAFT rather than ending the campaign.
        data: to === 'DRAFT' ? { state: 'DRAFT' } : { state: 'EXPIRED' },
      }),
    events: ({ to }) =>
      to === 'DRAFT'
        ? [{ name: 'campaign/returned', data: { campaignId, reason: 'funding_expired' } }]
        : [{ name: 'campaign/expired', data: { campaignId } }],
  })
  return result.to as CampaignState
}

/**
 * Brand or ops pulls a campaign mid-flight — edge case 4.
 * The campaign stops accepting claims immediately; open claims are honoured and paid,
 * and the remainder is refunded at close.
 */
export async function pause(campaignId: string, reason: string, actor: ActorRef): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'PAUSE',
    actor,
    reason,
    load: load(campaignId),
    apply: async (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { state: 'PAUSED', pausedAt: new Date() } }),
    events: () => [{ name: 'campaign/paused', data: { campaignId, reason } }],
  })
  return result.to as CampaignState
}

/**
 * Edge case 1: budget freed up because reservations released. Reopen for 24 hours,
 * once only — `reopenedAt` is the guard that makes "once" true.
 */
export async function reopen(campaignId: string, actor: ActorRef = SYSTEM): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'REOPEN',
    actor,
    load: load(campaignId),
    guard: async (tx, campaign) => {
      if (campaign.reopenedAt) throw new GuardError('ALREADY_REOPENED', 'This campaign has already reopened once')
      const balance = await campaignBalance(tx, campaignId)
      const releasedShare = balance.depositedOre > 0 ? balance.availableOre / balance.depositedOre : 0
      if (releasedShare < LIMITS.reopenReleaseRatio) {
        throw new GuardError('NOT_ENOUGH_RELEASED', 'Less than 20% of the budget has been released')
      }
    },
    apply: async (tx) =>
      tx.campaign.update({ where: { id: campaignId }, data: { state: 'FILLING', reopenedAt: new Date() } }),
    events: () => [{ name: 'campaign/reopened', data: { campaignId } }],
  })
  return result.to as CampaignState
}

// ---------------------------------------------------------------- close

const TERMINAL_PLACEMENT_STATES = [
  'PAID',
  'REJECTED',
  'EXPIRED',
  'REJECTED_BY_PARTICIPANT',
  'REJECTED_BY_BRAND',
] as const

/** True once every placement has reached a terminal state — docs/03 section 2. */
export async function allPlacementsTerminal(campaignId: string, tx?: Tx): Promise<boolean> {
  const open = await (tx ?? prisma).placement.count({
    where: {
      campaignId,
      deletedAt: null,
      state: { notIn: [...TERMINAL_PLACEMENT_STATES] },
    },
  })
  return open === 0
}

export async function reconcile(campaignId: string, actor: ActorRef = SYSTEM): Promise<CampaignState> {
  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'RECONCILE',
    actor,
    load: load(campaignId),
    guard: async (tx) => {
      if (!(await allPlacementsTerminal(campaignId, tx))) {
        throw new GuardError('OPEN_PLACEMENTS', 'Placements are still open')
      }
    },
    apply: async (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: {
          state: 'RECONCILING',
          reconcilingAt: new Date(),
          disputeWindowEndsAt: new Date(Date.now() + TIMEOUT_MS.disputeWindow),
        },
      }),
    events: () => [{ name: 'campaign/reconciling', data: { campaignId } }],
  })
  return result.to as CampaignState
}

/**
 * RECONCILING -> CLOSED. Returns whatever is still available as a refund, or rolls it
 * over to the brand's next campaign if that is their preference (docs/03 section 4).
 */
export async function close(
  campaignId: string,
  args: { mode: 'refund' | 'rollover'; externalRef?: string; rolloverToCampaignId?: string },
  actor: ActorRef = SYSTEM,
): Promise<{ state: CampaignState; returnedOre: number }> {
  let returnedOre = 0

  const result = await runTransition({
    entity: 'Campaign',
    entityId: campaignId,
    table: CAMPAIGN_TABLE,
    event: 'CLOSE',
    actor,
    payload: { mode: args.mode },
    load: load(campaignId),
    apply: async (tx) => {
      const balance = await campaignBalance(tx, campaignId)
      returnedOre = balance.availableOre

      if (returnedOre > 0) {
        if (args.mode === 'refund') {
          await refund(tx, campaignId, returnedOre, args.externalRef)
        } else {
          await rollover(
            tx,
            campaignId,
            returnedOre,
            args.rolloverToCampaignId ? `Rolled over to ${args.rolloverToCampaignId}` : 'Rolled over',
          )
        }
      }

      return tx.campaign.update({
        where: { id: campaignId },
        data: { state: 'CLOSED', closedAt: new Date() },
      })
    },
    events: () => [
      { name: 'campaign/closed', data: { campaignId, mode: args.mode, returnedOre } },
      ...(args.mode === 'refund' && returnedOre > 0
        ? ([{ name: 'money/refunded', data: { campaignId, amountOre: returnedOre } }] as const)
        : []),
    ],
  })

  return { state: result.to as CampaignState, returnedOre }
}

// ---------------------------------------------------------------- helpers

/**
 * Fill percentage for the dashboard and the 50/90/100% alerts.
 * "Filled" is spent plus reserved: money the brand can no longer spend on someone else.
 */
export async function fillPercent(campaignId: string, tx?: Tx): Promise<number> {
  const balance = await campaignBalance(tx ?? prisma, campaignId)
  if (balance.depositedOre === 0) return 0
  return Math.min(100, Math.round(((balance.spentOre + balance.reservedOre) / balance.depositedOre) * 100))
}

/** Campaign objects the go-live job should promote right now. */
export async function dueForGoLive(now: Date = new Date()): Promise<string[]> {
  const rows = await prisma.campaign.findMany({
    where: { state: 'FUNDED', deletedAt: null, goLiveAt: { lte: now } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

export type CampaignForClaim = Prisma.CampaignGetPayload<{ include: { payoutTemplate: true } }>
