/**
 * Shared state-machine machinery — CLAUDE.md non-negotiable 1.
 *
 * "Every Campaign, Placement, Participant and Money transition must be a named function
 *  that validates the current state, applies the transition, writes an AuditLog row,
 *  and emits an event. No ad-hoc status updates anywhere."
 *
 * This file is the only place that is allowed to change a `state` column. The four
 * lifecycle modules (campaign.ts, placement.ts, participant.ts, money.ts) build on it.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { emit, type NodEvent } from '@/lib/events'

export type Actor = 'PARTICIPANT' | 'BRAND' | 'SYSTEM' | 'OPS'

export type ActorRef = {
  kind: Actor
  /** User.id, BrandUser.id or ops user id. Absent for SYSTEM. */
  id?: string
}

export const SYSTEM: ActorRef = { kind: 'SYSTEM' }

export type Tx = Prisma.TransactionClient | PrismaClient

export class TransitionError extends Error {
  readonly entity: string
  readonly entityId: string
  readonly from: string
  readonly event: string

  constructor(entity: string, entityId: string, from: string, event: string, detail?: string) {
    super(
      detail ??
        `Illegal transition: ${entity} ${entityId} cannot handle "${event}" from state ${from}`,
    )
    this.name = 'TransitionError'
    this.entity = entity
    this.entityId = entityId
    this.from = from
    this.event = event
  }
}

/** Thrown when a guard fails for a reason the user should see (budget, cap, eligibility). */
export class GuardError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GuardError'
    this.code = code
  }
}

export function actorString(actor: ActorRef): string {
  return actor.id ? `${actor.kind.toLowerCase()}:${actor.id}` : actor.kind.toLowerCase()
}

/**
 * A transition table maps a from-state to the set of events it accepts, and each event
 * to the resulting state. Declaring it as data (rather than as `if` chains) is what lets
 * the tests assert that every illegal transition throws.
 */
export type TransitionTable<S extends string, E extends string> = {
  readonly [From in S]?: { readonly [Ev in E]?: S }
}

export function nextState<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  from: S,
  event: E,
): S | undefined {
  return table[from]?.[event]
}

export function canTransition<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  from: S,
  event: E,
): boolean {
  return nextState(table, from, event) !== undefined
}

/** Every state an entity can reach from `from` in one step. Used by ops "force" screens. */
export function allowedEvents<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  from: S,
): E[] {
  return Object.keys(table[from] ?? {}) as E[]
}

export type AuditWrite = {
  entity: string
  entityId: string
  fromState?: string | null
  toState?: string | null
  event: string
  actor: ActorRef
  reason?: string | null
  payload?: Prisma.InputJsonValue
}

export async function writeAudit(tx: Tx, entry: AuditWrite): Promise<void> {
  await tx.auditLog.create({
    data: {
      entity: entry.entity,
      entityId: entry.entityId,
      fromState: entry.fromState ?? null,
      toState: entry.toState ?? null,
      event: entry.event,
      actor: actorString(entry.actor),
      reason: entry.reason ?? null,
      payload: entry.payload ?? undefined,
    },
  })
}

export type TransitionResult<T> = {
  entity: T
  from: string
  to: string
  event: string
}

export type RunTransitionArgs<S extends string, E extends string, T> = {
  entity: string
  entityId: string
  table: TransitionTable<S, E>
  event: E
  actor: ActorRef
  reason?: string | null
  /** Extra audit payload. Never put a personnummer or a token in here (docs/07). */
  payload?: Prisma.InputJsonValue
  /** Loads the row and its current state inside the transaction. */
  load: (tx: Tx) => Promise<{ state: S } & Record<string, unknown>>
  /** Runs before the state is written. Throw GuardError to refuse with a reason. */
  guard?: (tx: Tx, entity: { state: S } & Record<string, unknown>) => Promise<void> | void
  /** Applies the state change plus any side effects, all inside the same transaction. */
  apply: (
    tx: Tx,
    ctx: { entity: { state: S } & Record<string, unknown>; from: S; to: S },
  ) => Promise<T>
  /** Events queued here are emitted only after the transaction commits. */
  events?: (ctx: { entity: T; from: S; to: S }) => NodEvent[]
}

/**
 * Run one transition: validate -> guard -> apply -> audit, in a single transaction.
 * Inngest events are emitted after commit so a rolled-back transition never fires a job.
 */
export async function runTransition<S extends string, E extends string, T>(
  args: RunTransitionArgs<S, E, T>,
  outerTx?: Tx,
): Promise<TransitionResult<T>> {
  const body = async (tx: Tx): Promise<{ result: TransitionResult<T>; events: NodEvent[] }> => {
    const current = await args.load(tx)
    const from = current.state
    const to = nextState(args.table, from, args.event)

    if (to === undefined) {
      throw new TransitionError(args.entity, args.entityId, from, args.event)
    }

    if (args.guard) await args.guard(tx, current)

    const entity = await args.apply(tx, { entity: current, from, to })

    await writeAudit(tx, {
      entity: args.entity,
      entityId: args.entityId,
      fromState: from,
      toState: to,
      event: args.event,
      actor: args.actor,
      reason: args.reason ?? null,
      payload: args.payload,
    })

    return {
      result: { entity, from, to, event: args.event },
      events: args.events?.({ entity, from, to }) ?? [],
    }
  }

  const { result, events } = outerTx
    ? await body(outerTx)
    : await prisma.$transaction((tx) => body(tx), { timeout: 20_000 })

  for (const event of events) await emit(event)
  return result
}

/**
 * Audit an action that is not itself a state change (an ops note, a flag edit, a
 * regeneration). Keeps everything a human did in one queryable place.
 */
export async function auditAction(
  tx: Tx,
  entity: string,
  entityId: string,
  event: string,
  actor: ActorRef,
  payload?: Prisma.InputJsonValue,
  reason?: string,
): Promise<void> {
  await writeAudit(tx, { entity, entityId, event, actor, payload, reason })
}
