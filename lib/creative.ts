/**
 * Creative as a distribution layer.
 *
 * A brand uploads a product once and NOD distributes it into many people's posts. The
 * consequence the brand cares about: the creative is not frozen at launch. A new pack
 * design, a seasonal label, a logo refresh — the brand swaps the asset and every
 * placement that has not yet been approved by its participant is re-rendered with the
 * new one. Nothing a participant has already approved changes under them: from
 * BRAND_REVIEW onward the image is locked, because the participant said yes to *that*
 * picture and will be publishing it to their own account.
 *
 * The participant's region choice is kept (it is their training label), and the swap
 * does not consume any of their three regenerations.
 */

import 'server-only'
import type { Prisma } from '@prisma/client'
import { prisma } from './db'
import { log } from './logger'
import { generate, renderPlacement } from './render'
import { regenerate, retryGeneration } from './state/placement'
import { auditAction, type ActorRef } from './state/transition'

/** States where the creative can still change: nobody has approved an image yet. */
export const SWAPPABLE_STATES = ['POSITIONED', 'GENERATING', 'GENERATION_FAILED', 'PARTICIPANT_REVIEW'] as const

export type ReplaceCreativeResult = {
  retiredAssetId: string
  replacementAssetId: string
  reRendered: number
  deferred: number
  failed: number
}

export class CreativeError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'DIFFERENT_CAMPAIGN' | 'SAME_ASSET' | 'LAST_ASSET',
    message: string,
  ) {
    super(message)
    this.name = 'CreativeError'
  }
}

/** How many placements are still swappable per asset — what the assets page shows. */
export async function inFlightByAsset(campaignId: string): Promise<Map<string, number>> {
  const rows = await prisma.placement.groupBy({
    by: ['assetId'],
    where: { campaignId, deletedAt: null, state: { in: [...SWAPPABLE_STATES] }, assetId: { not: null } },
    _count: { _all: true },
  })
  return new Map(rows.map((r) => [r.assetId as string, r._count._all]))
}

/**
 * Retires `fromAssetId`, points every swappable placement at `toAssetId`, and re-renders
 * them. Runs the swaps after the retire commits so a render failure cannot leave the
 * old asset both retired and still referenced by a live position.
 */
export async function replaceCreative(
  args: { campaignId: string; fromAssetId: string; toAssetId: string; actor: ActorRef },
): Promise<ReplaceCreativeResult> {
  if (args.fromAssetId === args.toAssetId) throw new CreativeError('SAME_ASSET', 'Choose a different asset')

  const [from, to] = await Promise.all([
    prisma.campaignAsset.findFirst({ where: { id: args.fromAssetId, deletedAt: null } }),
    prisma.campaignAsset.findFirst({ where: { id: args.toAssetId, deletedAt: null } }),
  ])
  if (!from || !to) throw new CreativeError('NOT_FOUND', 'Asset not found')
  if (from.campaignId !== args.campaignId || to.campaignId !== args.campaignId) {
    throw new CreativeError('DIFFERENT_CAMPAIGN', 'Assets belong to another campaign')
  }

  const affected = await prisma.placement.findMany({
    where: { campaignId: args.campaignId, assetId: from.id, deletedAt: null, state: { in: [...SWAPPABLE_STATES] } },
    select: { id: true, state: true },
  })

  await prisma.$transaction(async (tx) => {
    await tx.campaignAsset.update({ where: { id: from.id }, data: { deletedAt: new Date() } })
    await auditAction(tx, 'CampaignAsset', from.id, 'RETIRE', args.actor, {
      replacedBy: to.id,
      affected: affected.map((p) => p.id),
    })
  })

  const result: ReplaceCreativeResult = {
    retiredAssetId: from.id,
    replacementAssetId: to.id,
    reRendered: 0,
    deferred: 0,
    failed: 0,
  }

  for (const placement of affected) {
    const outcome = await swapOne(placement.id, placement.state, from.id, to.id, args.actor)
    if (outcome === 'rendered') result.reRendered += 1
    else if (outcome === 'deferred') result.deferred += 1
    else if (outcome === 'failed') result.failed += 1
  }

  log.info('creative replaced', { campaignId: args.campaignId, ...result })
  return result
}

async function swapOne(
  placementId: string,
  state: string,
  fromAssetId: string,
  toAssetId: string,
  actor: ActorRef,
): Promise<'rendered' | 'deferred' | 'failed' | 'skipped'> {
  const swapPayload = { from: fromAssetId, to: toAssetId, by: actor.kind } as Prisma.InputJsonValue

  switch (state) {
    case 'PARTICIPANT_REVIEW':
      // The state machine's REGENERATE row, flagged as not the participant's doing.
      await regenerate(placementId, { kind: 'SWAP', assetId: toAssetId, countsTowardLimit: false, reason: 'brand swapped creative' }, actor)
      return generate(placementId, actor)

    case 'POSITIONED':
      await recordSwap(placementId, toAssetId, swapPayload)
      return generate(placementId, actor)

    case 'GENERATION_FAILED':
      await recordSwap(placementId, toAssetId, swapPayload)
      await retryGeneration(placementId, actor)
      return renderPlacement(placementId, actor)

    case 'GENERATING':
      // Already with the engine or the ops queue; point it at the new asset and ask again.
      await recordSwap(placementId, toAssetId, swapPayload)
      return renderPlacement(placementId, actor)

    default:
      return 'skipped'
  }
}

/** Not a state transition — the asset pointer moves, and the event stream says who moved it. */
async function recordSwap(placementId: string, toAssetId: string, payload: Prisma.InputJsonValue): Promise<void> {
  await prisma.$transaction([
    prisma.placementEvent.create({ data: { placementId, type: 'SWAP', payload } }),
    prisma.placement.update({ where: { id: placementId }, data: { assetId: toAssetId } }),
  ])
}
