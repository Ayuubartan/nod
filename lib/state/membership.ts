/**
 * CampaignMembership lifecycle — docs/14 §2. A creator's seat in a CLIP campaign.
 *
 * Join is DB-only (docs/14 D7): the checks are all rows we already have, and the unique
 * constraint on (campaignId, userId) is what settles a double-click race.
 */

import type { MembershipState, Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { emit } from '@/lib/events'
import { isClaimable } from './campaign'
import {
  GuardError,
  runTransition,
  SYSTEM,
  type ActorRef,
  type TransitionTable,
  type Tx,
} from './transition'

export type MembershipEvent = 'LEAVE' | 'REJOIN' | 'SUSPEND' | 'BLOCK' | 'REINSTATE'

export const MEMBERSHIP_TABLE: TransitionTable<MembershipState, MembershipEvent> = {
  JOINED: { LEAVE: 'LEFT', SUSPEND: 'SUSPENDED', BLOCK: 'BLOCKED' },
  LEFT: { REJOIN: 'JOINED', BLOCK: 'BLOCKED' },
  SUSPENDED: { REINSTATE: 'JOINED', BLOCK: 'BLOCKED' },
  BLOCKED: {},
}

export class JoinError extends GuardError {}

const load = (id: string) => async (tx: Tx) =>
  tx.campaignMembership.findUniqueOrThrow({
    where: { id },
    select: { id: true, state: true, campaignId: true, userId: true },
  })

/**
 * Join, or re-join after leaving. Returns the membership id and whether the seat is new.
 * Never calls a provider (docs/14 D7).
 */
export async function joinCampaign(
  input: { campaignId: string; userId: string },
  now: Date = new Date(),
): Promise<{ id: string; created: boolean }> {
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.findUniqueOrThrow({
      where: { id: input.campaignId },
      select: {
        kind: true,
        state: true,
        endsAt: true,
        joinCap: true,
        joinsPausedAt: true,
        platforms: true,
        minFollowers: true,
        maxFollowers: true,
        deletedAt: true,
      },
    })
    if (campaign.kind !== 'CLIP' || campaign.deletedAt) throw new JoinError('NOT_CLIP', 'Not a clip campaign')
    // EXHAUSTED campaigns still accept members — their posts are tracked, marked not payable (D2).
    if (!isClaimable(campaign.state) && campaign.state !== 'EXHAUSTED') {
      throw new JoinError('CAMPAIGN_NOT_OPEN', `Campaign is ${campaign.state}`)
    }
    if (campaign.endsAt && campaign.endsAt <= now) throw new JoinError('CAMPAIGN_ENDED', 'Campaign has ended')
    if (campaign.joinsPausedAt) throw new JoinError('JOINS_PAUSED', 'Joins are paused')

    const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { state: true } })
    if (user.state !== 'VERIFIED' && user.state !== 'ACTIVE') {
      throw new JoinError('NOT_ELIGIBLE', `Participant is ${user.state}`)
    }

    // D5: at least one API-connected account on a campaign platform, within the follower band.
    const accounts = await tx.socialAccount.findMany({
      where: { userId: input.userId, deletedAt: null, tier: 'CONNECTED_API', platform: { in: campaign.platforms } },
      select: { followers: true },
    })
    if (accounts.length === 0) throw new JoinError('NO_CONNECTED_ACCOUNT', 'Connect an account on a campaign platform first')
    const eligible = accounts.some(
      (a) => a.followers >= campaign.minFollowers && (!campaign.maxFollowers || a.followers <= campaign.maxFollowers),
    )
    if (!eligible) throw new JoinError('FOLLOWERS', 'No account inside the follower band')

    const existing = await tx.campaignMembership.findUnique({
      where: { campaignId_userId: { campaignId: input.campaignId, userId: input.userId } },
      select: { id: true, state: true },
    })

    if (existing?.state === 'JOINED') return { id: existing.id, created: false }
    if (existing && existing.state !== 'LEFT') {
      throw new JoinError('MEMBERSHIP_' + existing.state, `Membership is ${existing.state}`)
    }

    // A creator who left gave their seat up; coming back competes for one like anyone else.
    if (campaign.joinCap != null) {
      const seats = await tx.campaignMembership.count({
        where: { campaignId: input.campaignId, state: { in: ['JOINED', 'SUSPENDED'] }, deletedAt: null },
      })
      if (seats >= campaign.joinCap) throw new JoinError('FULL', 'Campaign is full')
    }

    if (existing) {
      await runTransition(
        {
          entity: 'CampaignMembership',
          entityId: existing.id,
          table: MEMBERSHIP_TABLE,
          event: 'REJOIN',
          actor: { kind: 'PARTICIPANT', id: input.userId },
          load: load(existing.id),
          apply: async (inner) =>
            inner.campaignMembership.update({ where: { id: existing.id }, data: { state: 'JOINED', joinedAt: now, leftAt: null } }),
          events: () => [{ name: 'membership/joined', data: { membershipId: existing.id, campaignId: input.campaignId, userId: input.userId } }],
        },
        tx,
      )
      return { id: existing.id, created: false }
    }

    const membership = await tx.campaignMembership.create({
      data: { campaignId: input.campaignId, userId: input.userId, state: 'JOINED', joinedAt: now },
      select: { id: true },
    })
    await tx.auditLog.create({
      data: {
        entity: 'CampaignMembership',
        entityId: membership.id,
        toState: 'JOINED',
        event: 'JOIN',
        actor: `participant:${input.userId}`,
        payload: { campaignId: input.campaignId } as Prisma.InputJsonValue,
      },
    })
    return { id: membership.id, created: true }
  }).then(async (result) => {
    // Emitted after commit, like runTransition does for its own events.
    if (result.created) {
      await emit({ name: 'membership/joined', data: { membershipId: result.id, campaignId: input.campaignId, userId: input.userId } })
    }
    return result
  })
}

/** Leave. Existing submissions keep tracking and paying (docs/14 §2). */
export async function leaveCampaign(membershipId: string, actor: ActorRef): Promise<MembershipState> {
  const result = await runTransition({
    entity: 'CampaignMembership',
    entityId: membershipId,
    table: MEMBERSHIP_TABLE,
    event: 'LEAVE',
    actor,
    load: load(membershipId),
    apply: async (tx) =>
      tx.campaignMembership.update({ where: { id: membershipId }, data: { state: 'LEFT', leftAt: new Date() } }),
    events: ({ entity }) => [{ name: 'membership/left', data: { membershipId, campaignId: entity.campaignId, userId: entity.userId } }],
  })
  return result.to as MembershipState
}

/** Fraud disposition SUSPEND_CREATOR (docs/14 §5). Reversible by ops. */
export async function suspendMembership(membershipId: string, reason: string, actor: ActorRef = SYSTEM, tx?: Tx): Promise<MembershipState> {
  const result = await runTransition(
    {
      entity: 'CampaignMembership',
      entityId: membershipId,
      table: MEMBERSHIP_TABLE,
      event: 'SUSPEND',
      actor,
      reason,
      load: load(membershipId),
      apply: async (inner) =>
        inner.campaignMembership.update({ where: { id: membershipId }, data: { state: 'SUSPENDED', note: reason } }),
      events: ({ entity }) => [{ name: 'membership/suspended', data: { membershipId, campaignId: entity.campaignId, userId: entity.userId, reason } }],
    },
    tx,
  )
  return result.to as MembershipState
}

export async function blockMembership(membershipId: string, reason: string, actor: ActorRef): Promise<MembershipState> {
  const result = await runTransition({
    entity: 'CampaignMembership',
    entityId: membershipId,
    table: MEMBERSHIP_TABLE,
    event: 'BLOCK',
    actor,
    reason,
    load: load(membershipId),
    apply: async (tx) => tx.campaignMembership.update({ where: { id: membershipId }, data: { state: 'BLOCKED', note: reason } }),
    events: ({ entity }) => [{ name: 'membership/blocked', data: { membershipId, campaignId: entity.campaignId, userId: entity.userId, reason } }],
  })
  return result.to as MembershipState
}

export async function reinstateMembership(membershipId: string, reason: string, actor: ActorRef): Promise<MembershipState> {
  const result = await runTransition({
    entity: 'CampaignMembership',
    entityId: membershipId,
    table: MEMBERSHIP_TABLE,
    event: 'REINSTATE',
    actor,
    reason,
    load: load(membershipId),
    apply: async (tx) => tx.campaignMembership.update({ where: { id: membershipId }, data: { state: 'JOINED', note: reason } }),
    events: ({ entity }) => [{ name: 'membership/reinstated', data: { membershipId, campaignId: entity.campaignId, userId: entity.userId } }],
  })
  return result.to as MembershipState
}
