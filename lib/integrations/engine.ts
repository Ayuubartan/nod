/**
 * Placement engine — docs/06 section 6.
 *
 * Implementations, in the order the build plan introduces them:
 *   1. OpsQueueEngine      (M2) — heuristic candidates, human renders. This was the pilot.
 *   2. LocalCompositeEngine     — in-process compositor, the default now (./composite.ts).
 *   3. HostedInpaintEngine (M5) — a hosted image-editing API behind the same interface.
 *   4. ParallelEngine   (later) — the in-house engine.
 *
 * Every render writes a PlacementVersion and every participant action on it writes a
 * PlacementEvent. That stream, filtered to trainingConsent, is what trains Parallel.
 */

import type { PlacementEngine, Region, RenderResult } from './types'
import { heuristicRegions } from '@/lib/regions'
import { log } from '@/lib/logger'

// Re-exported for server callers; lib/regions.ts is the client-safe home for it.
export { heuristicRegions }

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
 * M5 implementation 2 lives in ./inpaint.ts, which pulls in sharp and the storage layer.
 * It is imported lazily below so a deployment that has not enabled it never loads it.
 */

/**
 * Wraps a real engine so a provider failure degrades to the ops queue instead of costing
 * the participant their 48 hours (docs/03 P-04: retry twice, then a human).
 *
 * This is what lets M5 ship incrementally: the hosted engine can be turned on for real
 * traffic while the manual queue stays as the safety net underneath it.
 */
export class FallbackEngine implements PlacementEngine {
  readonly name: string

  constructor(
    private readonly primary: PlacementEngine,
    private readonly fallback: PlacementEngine = new OpsQueueEngine(),
  ) {
    this.name = `${primary.name}+fallback`
  }

  async candidates(imagePath: string): Promise<Region[]> {
    try {
      return await this.primary.candidates(imagePath)
    } catch {
      return this.fallback.candidates(imagePath)
    }
  }

  async render(args: Parameters<PlacementEngine['render']>[0]): Promise<RenderResult> {
    try {
      return await this.primary.render(args)
    } catch (error) {
      log.error('placement engine failed, falling back to the ops queue', error, {
        engine: this.primary.name,
        placementId: args.placementId,
      })
      return this.fallback.render(args)
    }
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

export type EngineMode = 'auto' | 'hosted' | 'local' | 'ops' | 'fake'

/**
 * `NOD_ENGINE` picks the chain explicitly; unset means the best available. Unlike the
 * other integrations this does not follow NOD_FAKE_PROVIDERS: the local compositor has no
 * third party behind it, so dev gets real renders. Tests set NOD_ENGINE=fake themselves.
 */
export function engineMode(): EngineMode {
  const raw = process.env.NOD_ENGINE
  if (raw === 'hosted' || raw === 'local' || raw === 'ops' || raw === 'fake') return raw
  return 'auto'
}

/**
 * Engine selection. The chain, top to bottom, is what docs/06 section 6 describes plus
 * the local compositor that makes placement direct for everyone:
 *
 *   hosted inpaint (when INPAINT_PROVIDER + INPAINT_API_KEY are set)
 *     -> local composite (always available: sharp, in-process, free)
 *       -> ops queue (a human renders; never fails)
 *
 * Every layer is wrapped in FallbackEngine, so a provider outage degrades one step
 * rather than stranding the participant in GENERATING.
 */
export function placementEngine(): PlacementEngine {
  if (cached) return cached

  const mode = engineMode()

  if (mode === 'fake') {
    cached = new FakeEngine()
    return cached
  }

  if (mode === 'ops') {
    cached = new OpsQueueEngine()
    return cached
  }

  // Required lazily so sharp and the storage client stay out of bundles that never
  // render (the client-safe region helpers live in lib/regions.ts for that reason).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LocalCompositeEngine } = require('./composite') as typeof import('./composite')
  const local = new FallbackEngine(new LocalCompositeEngine())

  const hostedConfigured = Boolean(process.env.INPAINT_API_KEY && process.env.INPAINT_PROVIDER)
  if (mode === 'hosted' || (mode === 'auto' && hostedConfigured)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HostedInpaintEngine } = require('./inpaint') as typeof import('./inpaint')
    cached = new FallbackEngine(new HostedInpaintEngine(), local)
    return cached
  }

  cached = local
  return cached
}

export function setPlacementEngine(engine: PlacementEngine | null): void {
  cached = engine
}
