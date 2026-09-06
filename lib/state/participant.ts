/**
 * Participant lifecycle — docs/03 section 3.
 *
 *   SIGNED_UP -> ONBOARDED -> VERIFIED -> ACTIVE
 *                                  |         |
 *                              FLAGGED <-----+
 *                                  |
 *                            SUSPENDED -> ACTIVE (after 90d) | REMOVED
 *
 * Every transition validates its from-state, writes an AuditLog row and emits an event
 * (CLAUDE.md rule 1). Illegal transitions throw TransitionError.
 */

import type { ParticipantState, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { hashSubject } from '@/lib/crypto'
import { LIMITS } from '@/lib/money/rates'
import {
  GuardError,
  runTransition,
  SYSTEM,
  type ActorRef,
  type TransitionTable,
  type Tx,
} from './transition'

export type ParticipantEvent =
  | 'ONBOARD'
  | 'VERIFY'
  | 'ACTIVATE'
  | 'FLAG'
  | 'CLEAR_FLAG'
  | 'SUSPEND'
  | 'RESTORE'
  | 'REMOVE'

/**
 * The table is the spec. Anything not listed here is an illegal transition.
 *
 * Notes on the less obvious rows:
 *  - FLAG is reachable from VERIFIED as well as ACTIVE: a participant can be flagged on
 *    their very first claim, before any placement has been approved.
 *  - SUSPEND is reachable directly from VERIFIED/ACTIVE for one serious strike, without
 *    passing through FLAGGED (docs/03: "1 serious or 3 minor strikes").
 *  - RESTORE from SUSPENDED goes to ACTIVE, which is the auto-restore after 90 days.
 *  - REMOVED is terminal in every direction. Re-registration is blocked by the retained
 *    subject hash, not by a transition.
 */
export const PARTICIPANT_TABLE: TransitionTable<ParticipantState, ParticipantEvent> = {
  SIGNED_UP: { ONBOARD: 'ONBOARDED', REMOVE: 'REMOVED' },
  ONBOARDED: { VERIFY: 'VERIFIED', REMOVE: 'REMOVED' },
  VERIFIED: { ACTIVATE: 'ACTIVE', FLAG: 'FLAGGED', SUSPEND: 'SUSPENDED', REMOVE: 'REMOVED' },
  ACTIVE: { FLAG: 'FLAGGED', SUSPEND: 'SUSPENDED', REMOVE: 'REMOVED' },
  FLAGGED: { CLEAR_FLAG: 'ACTIVE', SUSPEND: 'SUSPENDED', REMOVE: 'REMOVED' },
  SUSPENDED: { RESTORE: 'ACTIVE', REMOVE: 'REMOVED' },
  REMOVED: {},
}

/** States in which a participant may claim a campaign — docs/03 section 3 "Can". */
export const CAN_CLAIM: ParticipantState[] = ['VERIFIED', 'ACTIVE']

export function canClaim(state: ParticipantState): boolean {
  return CAN_CLAIM.includes(state)
}

const load = (userId: string) => async (tx: Tx) =>
  tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, state: true, locale: true, referredById: true, deletedAt: true },
  })

// ---------------------------------------------------------------- transitions

/**
 * SIGNED_UP -> ONBOARDED. Requires everything docs/02 A1 collects: at least one
 * connected account, accepted terms, a passed disclosure quiz and a payout number.
 */
export async function onboard(userId: string, actor: ActorRef): Promise<ParticipantState> {
  const result = await runTransition({
    entity: 'Participant',
    entityId: userId,
    table: PARTICIPANT_TABLE,
    event: 'ONBOARD',
    actor,
    load: load(userId),
    guard: async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          termsAcceptedAt: true,
          disclosureQuizAt: true,
          swishNumber: true,
          accounts: { where: { deletedAt: null }, select: { id: true } },
        },
      })
      if (user.accounts.length === 0) {
        throw new GuardError('NO_ACCOUNT', 'Connect at least one social account first')
      }
      if (!user.termsAcceptedAt) throw new GuardError('NO_TERMS', 'Terms must be accepted')
      if (!user.disclosureQuizAt) {
        throw new GuardError('NO_QUIZ', 'The disclosure check must be passed')
      }
      if (!user.swishNumber) throw new GuardError('NO_PAYOUT', 'A payout number is required')
    },
    apply: async (tx) => tx.user.update({ where: { id: userId }, data: { state: 'ONBOARDED', onboardingStep: 9 } }),
    events: () => [{ name: 'participant/onboarded', data: { userId }, id: `onboarded:${userId}` }],
  })
  return result.to as ParticipantState
}

export class IdentityError extends Error {
  readonly code: 'UNDER_18' | 'DUPLICATE'

  constructor(code: 'UNDER_18' | 'DUPLICATE') {
    super(code === 'UNDER_18' ? 'Participant is under 18' : 'This person already has a NOD account')
    this.name = 'IdentityError'
    this.code = code
  }
}

/**
 * ONBOARDED -> VERIFIED, on a completed BankID flow.
 *
 * Takes the broker's raw subject and hashes it here, so no caller can accidentally
 * persist it. Only the hash, the birth year and the timestamp are stored (docs/07).
 */
export async function verifyIdentity(
  userId: string,
  identity: { subject: string; birthYear: number; provider: string },
  actor: ActorRef = SYSTEM,
  now: Date = new Date(),
): Promise<ParticipantState> {
  const subjectHash = hashSubject(identity.subject)
  const age = now.getFullYear() - identity.birthYear

  // Age and duplicate are checked before the transition so the caller gets a specific
  // error rather than a generic guard failure, and so nothing is written on refusal.
  if (age < 18) throw new IdentityError('UNDER_18')

  const clash = await prisma.identity.findUnique({
    where: { subjectHash },
    select: { userId: true },
  })
  if (clash && clash.userId !== userId) throw new IdentityError('DUPLICATE')

  const result = await runTransition({
    entity: 'Participant',
    entityId: userId,
    table: PARTICIPANT_TABLE,
    event: 'VERIFY',
    actor,
    // Deliberately excludes anything derived from the personnummer.
    payload: { provider: identity.provider, birthYear: identity.birthYear },
    load: load(userId),
    apply: async (tx) => {
      await tx.identity.upsert({
        where: { userId },
        create: { userId, subjectHash, birthYear: identity.birthYear, verifiedAt: now, provider: identity.provider },
        update: { subjectHash, birthYear: identity.birthYear, verifiedAt: now, provider: identity.provider },
      })
      await tx.wallet.upsert({ where: { userId }, create: { userId }, update: {} })
      return tx.user.update({ where: { id: userId }, data: { state: 'VERIFIED' } })
    },
    events: () => [{ name: 'participant/verified', data: { userId }, id: `verified:${userId}` }],
  })
  return result.to as ParticipantState
}

/** VERIFIED -> ACTIVE on the first APPROVED placement — docs/03 section 3. */
export async function activate(userId: string, actor: ActorRef = SYSTEM, tx?: Tx): Promise<ParticipantState> {
  const result = await runTransition(
    {
      entity: 'Participant',
      entityId: userId,
      table: PARTICIPANT_TABLE,
      event: 'ACTIVATE',
      actor,
      load: load(userId),
      apply: async (inner) => inner.user.update({ where: { id: userId }, data: { state: 'ACTIVE' } }),
      events: () => [{ name: 'participant/active', data: { userId } }],
    },
    tx,
  )
  return result.to as ParticipantState
}

/** Best-effort activation: does nothing if the participant is already ACTIVE or beyond. */
export async function activateIfFirstApproval(userId: string, tx?: Tx): Promise<void> {
  const user = await (tx ?? prisma).user.findUniqueOrThrow({ where: { id: userId }, select: { state: true } })
  if (user.state === 'VERIFIED') await activate(userId, SYSTEM, tx)
}

export async function flag(userId: string, reason: string, actor: ActorRef, tx?: Tx): Promise<ParticipantState> {
  const result = await runTransition(
    {
      entity: 'Participant',
      entityId: userId,
      table: PARTICIPANT_TABLE,
      event: 'FLAG',
      actor,
      reason,
      load: load(userId),
      apply: async (inner) => inner.user.update({ where: { id: userId }, data: { state: 'FLAGGED' } }),
      events: () => [{ name: 'participant/flagged', data: { userId, reason } }],
    },
    tx,
  )
  return result.to as ParticipantState
}

/** Ops decided the flag was wrong — docs/03: "ops clear -> ACTIVE". */
export async function clearFlag(userId: string, reason: string, actor: ActorRef): Promise<ParticipantState> {
  const result = await runTransition({
    entity: 'Participant',
    entityId: userId,
    table: PARTICIPANT_TABLE,
    event: 'CLEAR_FLAG',
    actor,
    reason,
    load: load(userId),
    apply: async (tx) => tx.user.update({ where: { id: userId }, data: { state: 'ACTIVE' } }),
    events: () => [{ name: 'participant/active', data: { userId, cleared: true } }],
  })
  return result.to as ParticipantState
}

export async function suspend(userId: string, reason: string, actor: ActorRef, tx?: Tx): Promise<ParticipantState> {
  const result = await runTransition(
    {
      entity: 'Participant',
      entityId: userId,
      table: PARTICIPANT_TABLE,
      event: 'SUSPEND',
      actor,
      reason,
      load: load(userId),
      apply: async (inner) => inner.user.update({ where: { id: userId }, data: { state: 'SUSPENDED' } }),
      events: () => [{ name: 'participant/suspended', data: { userId, reason } }],
    },
    tx,
  )
  return result.to as ParticipantState
}

/** Auto-restore after the suspension period, or an ops override. */
export async function restore(userId: string, reason: string, actor: ActorRef = SYSTEM): Promise<ParticipantState> {
  const result = await runTransition({
    entity: 'Participant',
    entityId: userId,
    table: PARTICIPANT_TABLE,
    event: 'RESTORE',
    actor,
    reason,
    load: load(userId),
    apply: async (tx) => tx.user.update({ where: { id: userId }, data: { state: 'ACTIVE' } }),
    events: () => [{ name: 'participant/active', data: { userId, restored: true } }],
  })
  return result.to as ParticipantState
}

/**
 * Terminal. The Identity row (and therefore the subject hash) is deliberately NOT
 * deleted — it is what blocks re-registration (docs/06 section 3, docs/07 section 3).
 * The GDPR erasure job clears everything else.
 */
export async function remove(userId: string, reason: string, actor: ActorRef): Promise<ParticipantState> {
  const result = await runTransition({
    entity: 'Participant',
    entityId: userId,
    table: PARTICIPANT_TABLE,
    event: 'REMOVE',
    actor,
    reason,
    load: load(userId),
    apply: async (tx) =>
      tx.user.update({ where: { id: userId }, data: { state: 'REMOVED', deletedAt: new Date() } }),
    events: () => [{ name: 'participant/removed', data: { userId, reason } }],
  })
  return result.to as ParticipantState
}

// ---------------------------------------------------------------- strikes

export type StrikeInput = {
  userId: string
  severity: 'MINOR' | 'SERIOUS'
  reason: string
  placementId?: string
}

/**
 * Record a strike and apply the consequence — docs/03 section 3 "Strikes".
 * One serious or three minor strikes suspends. A minor strike below the threshold
 * flags rather than suspends, so ops sees it before it costs the participant anything.
 */
export async function addStrike(
  input: StrikeInput,
  actor: ActorRef = SYSTEM,
  tx?: Tx,
): Promise<{ suspended: boolean; flagged: boolean }> {
  const client = tx ?? prisma

  await client.strike.create({
    data: {
      userId: input.userId,
      severity: input.severity,
      reason: input.reason,
      placementId: input.placementId ?? null,
    },
  })

  const strikes = await client.strike.findMany({
    where: { userId: input.userId, deletedAt: null },
    select: { severity: true },
  })
  const serious = strikes.filter((s) => s.severity === 'SERIOUS').length
  const minor = strikes.filter((s) => s.severity === 'MINOR').length

  const user = await client.user.findUniqueOrThrow({ where: { id: input.userId }, select: { state: true } })

  const shouldSuspend =
    serious >= LIMITS.seriousStrikesToSuspend || minor >= LIMITS.minorStrikesToSuspend

  if (shouldSuspend && user.state !== 'SUSPENDED' && user.state !== 'REMOVED') {
    await suspend(input.userId, `Strike threshold reached: ${input.reason}`, actor, tx)
    return { suspended: true, flagged: false }
  }

  if (!shouldSuspend && (user.state === 'ACTIVE' || user.state === 'VERIFIED')) {
    await flag(input.userId, input.reason, actor, tx)
    return { suspended: false, flagged: true }
  }

  return { suspended: false, flagged: false }
}

/** Users whose 90-day suspension has elapsed — the restore job reads this. */
export async function suspendedLongerThan(days: number, now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'Participant', toState: 'SUSPENDED', createdAt: { lte: cutoff } },
    select: { entityId: true },
    orderBy: { createdAt: 'desc' },
  })
  const ids = [...new Set(rows.map((r) => r.entityId))]
  if (ids.length === 0) return []

  const stillSuspended = await prisma.user.findMany({
    where: { id: { in: ids }, state: 'SUSPENDED' },
    select: { id: true },
  })
  return stillSuspended.map((u) => u.id)
}

// ---------------------------------------------------------------- creation

export type SignUpInput = {
  authId: string
  email?: string | null
  locale?: string
  city?: string | null
  ageBracket?: string | null
  referredByCode?: string | null
}

/** Creates a participant in SIGNED_UP with a wallet and a referral code. */
export async function signUp(input: SignUpInput, referralCodeFactory: () => string): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    let referredById: string | null = null
    if (input.referredByCode) {
      const referrer = await tx.user.findUnique({
        where: { referralCode: input.referredByCode.toUpperCase() },
        select: { id: true },
      })
      referredById = referrer?.id ?? null
    }

    const user = await tx.user.create({
      data: {
        authId: input.authId,
        email: input.email ?? null,
        locale: input.locale ?? 'sv',
        city: input.city ?? null,
        ageBracket: input.ageBracket ?? null,
        referralCode: referralCodeFactory(),
        referredById,
        state: 'SIGNED_UP',
      },
      select: { id: true },
    })

    await tx.wallet.create({ data: { userId: user.id } })

    if (referredById) {
      await tx.referral.create({ data: { referrerId: referredById, referredId: user.id } })
    }

    await tx.auditLog.create({
      data: {
        entity: 'Participant',
        entityId: user.id,
        toState: 'SIGNED_UP',
        event: 'SIGN_UP',
        actor: 'participant',
        payload: { referred: Boolean(referredById) } as Prisma.InputJsonValue,
      },
    })

    return user
  })
}
