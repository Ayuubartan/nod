/**
 * Placement region geometry — client-safe.
 *
 * Separate from lib/integrations/engine.ts because the position step renders these in
 * the browser while the engine module reaches server-only code (storage, sharp, the
 * hosted inpainting client). Coordinates are normalised 0..1 so a choice made on a
 * phone preview survives the resize before the render.
 */

export type Region = { x: number; y: number; w: number; h: number; label?: string }

/**
 * The candidate surfaces offered before there is a model: the centre, the lower third
 * and the right third. Replaced by real proposals when Parallel lands; until then these
 * are also what the training export records as "what was offered" alongside what the
 * participant actually chose (docs/06 section 6).
 */
export function heuristicRegions(): Region[] {
  return [
    { x: 0.34, y: 0.36, w: 0.32, h: 0.28, label: 'centre' },
    { x: 0.08, y: 0.62, w: 0.4, h: 0.3, label: 'lower-third' },
    { x: 0.58, y: 0.24, w: 0.34, h: 0.34, label: 'right-third' },
  ]
}
