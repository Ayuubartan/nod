/**
 * Placement engine — docs/06 section 6.
 *
 * Implementations, in the order the build plan introduces them:
 *   1. OpsQueueEngine   (M2) — heuristic candidates, human renders. This is the pilot.
 *   2. HostedInpaintEngine (M5) — a hosted image-editing API behind the same interface.
 *   3. ParallelEngine   (later) — the in-house engine.
 *
 * Every render writes a PlacementVersion and every participant action on it writes a
 * PlacementEvent. That stream, filtered to trainingConsent, is what trains Parallel.
 */

import type { PlacementEngine, Region, RenderResult } from './types'

/**
 * Heuristic candidate surfaces used before there is a model: the centre, the lower
 * third and the right third. Coordinates are normalised 0..1 so they survive any
 * resize between the participant's upload and the render.
 */
export function heuristicRegions(): Region[] {
  return [
    { x: 0.34, y: 0.36, w: 0.32, h: 0.28, label: 'centre' },
    { x: 0.08, y: 0.62, w: 0.4, h: 0.3, label: 'lower-third' },
    { x: 0.58, y: 0.24, w: 0.34, h: 0.34, label: 'right-third' },
  ]
}

/**
 * The pilot engine. `render` does not produce an image: it marks the job deferred, and
 * the ops generation queue picks it up, composites in any tool, and uploads the result.
 * The placement stays in GENERATING with its participant clock paused until then.
 */
export class OpsQueueEngine implements PlacementEngine {
  readonly name = 'ops-queue'

  async candidates(): Promise<Region[]> {
    return heuristicRegions()
  }

  async render(args: {
    placementId: string
    imagePath: string
    region: Region
    assetPath: string
    params?: Record<string, unknown>
  }): Promise<RenderResult> {
    return {
      resultPath: '',
      engine: this.name,
      params: { region: args.region, assetPath: args.assetPath, ...args.params },
      deferred: true,
    }
  }
}

/**
 * M5 slot. Kept as a named class with the real shape so swapping it in is a one-line
 * change in `placementEngine()` rather than a refactor. Throws rather than silently
 * degrading, so a misconfiguration is loud.
 */
export class HostedInpaintEngine implements PlacementEngine {
  readonly name = 'hosted-inpaint'

  constructor(private readonly endpoint = process.env.INPAINT_ENDPOINT ?? '') {}

  async candidates(): Promise<Region[]> {
    return heuristicRegions()
  }

  async render(): Promise<RenderResult> {
    if (!this.endpoint) {
      throw new Error('HostedInpaintEngine requires INPAINT_ENDPOINT. Pick the provider before enabling it (docs/06 section 6).')
    }
    throw new Error('HostedInpaintEngine is not implemented yet — Milestone 5.')
  }
}

/** Deterministic engine for tests: returns immediately with a synthetic result path. */
export class FakeEngine implements PlacementEngine {
  readonly name = 'fake'

  async candidates(): Promise<Region[]> {
    return heuristicRegions()
  }

  async render(args: { placementId: string; region: Region }): Promise<RenderResult> {
    return {
      resultPath: `fake/versions/${args.placementId}.jpg`,
      engine: this.name,
      params: { region: args.region },
      deferred: false,
    }
  }
}

let cached: PlacementEngine | null = null

export function placementEngine(): PlacementEngine {
  if (cached) return cached
  cached = process.env.NOD_FAKE_PROVIDERS === '1' ? new FakeEngine() : new OpsQueueEngine()
  return cached
}

export function setPlacementEngine(engine: PlacementEngine | null): void {
  cached = engine
}
