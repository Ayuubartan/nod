/**
 * P-04 in one place. Every path that needs a version rendered — the participant
 * confirming a position, a regeneration, a brand swapping its creative, a retry after a
 * failure, ops pressing "run engine" — calls `renderPlacement`. Before this existed the
 * position step and the regenerate step each did half of the work differently, and a
 * regeneration never actually asked the engine for anything.
 *
 * The placement must already be GENERATING (P-04). `generate` is the convenience that
 * takes a POSITIONED placement there first.
 */

import 'server-only'
import type { Prisma } from '@prisma/client'
import { prisma } from './db'
import { flag } from './flags'
import { log, measured } from './logger'
import { OpsQueueEngine, placementEngine } from './integrations/engine'
import type { Region } from './integrations/types'
import { generationDone, generationFailed, startGeneration } from './state/placement'
import { SYSTEM, type ActorRef } from './state/transition'

export type RenderOutcome = 'rendered' | 'deferred' | 'failed' | 'skipped'

/**
 * Renders the current region + asset of a GENERATING placement.
 *
 *   rendered  — a PlacementVersion was written; the placement is in PARTICIPANT_REVIEW
 *   deferred  — the ops queue owns it; the placement stays GENERATING, clock paused
 *   failed    — inputs were missing or every engine threw; GENERATION_FAILED, retry job
 *   skipped   — the placement was not GENERATING, so nothing was done
 */
export async function renderPlacement(placementId: string, actor: ActorRef = SYSTEM): Promise<RenderOutcome> {
  const placement = await prisma.placement.findUnique({
    where: { id: placementId },
    select: { state: true, originalPath: true, regionJson: true, assetId: true },
  })
  if (!placement || placement.state !== 'GENERATING') return 'skipped'

  const region = placement.regionJson as Region | null
  const asset = placement.assetId
    ? await prisma.campaignAsset.findUnique({
        where: { id: placement.assetId },
        select: { id: true, name: true, storagePath: true },
      })
    : null

  if (!placement.originalPath || !region || !asset) {
    await generationFailed(placementId, 'Missing original, region or asset', actor)
    return 'failed'
  }

  // The flag is the ops kill switch: off means every render waits for a human, exactly
  // as in the M2 pilot, without a deploy.
  const engine = (await flag('engine.autoRender')) ? placementEngine() : new OpsQueueEngine()

  try {
    const result = await measured('placement.render', () =>
      engine.render({
        placementId,
        imagePath: placement.originalPath!,
        region,
        assetPath: asset.storagePath,
        params: { assetId: asset.id, assetName: asset.name },
      }),
    )

    if (result.deferred) {
      log.info('render deferred to ops queue', { placementId, engine: result.engine })
      return 'deferred'
    }

    await generationDone(
      placementId,
      {
        storagePath: result.resultPath,
        engine: result.engine,
        params: { ...result.params, assetId: asset.id } as Prisma.InputJsonValue as Record<string, unknown>,
      },
      actor,
    )
    return 'rendered'
  } catch (error) {
    // FallbackEngine already degraded through every layer; if we still get here the
    // inputs themselves are bad. P-04 says: fail, retry twice, then a human.
    log.error('render failed', error, { placementId })
    await generationFailed(placementId, error instanceof Error ? error.message : 'render failed', actor)
    return 'failed'
  }
}

/** POSITIONED -> GENERATING -> (render). What the position step and regenerate call. */
export async function generate(placementId: string, actor: ActorRef = SYSTEM): Promise<RenderOutcome> {
  await startGeneration(placementId, actor)
  return renderPlacement(placementId, actor)
}
