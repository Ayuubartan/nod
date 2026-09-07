/**
 * LocalCompositeEngine — the engine that makes placement direct.
 *
 * docs/06 section 6 lists three implementations: the ops queue (a human renders), a
 * hosted inpainting API, and the in-house engine. Between the first two there is a gap
 * the pilot kept falling into: with no provider key configured, every placement waited
 * for a person. This engine closes it. It composites the brand asset into the region the
 * participant chose, in-process with sharp, in well under a second, with no third party
 * and no cost per render.
 *
 * It is a compositor, not a generative model: it scales the product to the chosen
 * surface, sits it on the bottom edge of that surface, matches its brightness to the
 * scene and drops a soft shadow. That is what a careful human in the ops queue was doing
 * by hand, so making it the default loses nothing and gains the participant their result
 * on the same screen tap. The hosted inpainting engine sits above it when configured,
 * and the ops queue stays underneath as the safety net, so the chain is:
 *
 *   hosted inpaint (if configured) -> local composite -> ops queue
 *
 * Nothing outside the chosen region is ever touched, which is also the property the
 * media-match verification check depends on.
 */

import 'server-only'
import sharp from 'sharp'
import { get, paths, put } from '@/lib/storage'
import { randomToken } from '@/lib/crypto'
import { heuristicRegions } from '@/lib/regions'
import type { PlacementEngine, Region, RenderResult } from './types'

export type CompositeOptions = {
  /** How much of the region the product may fill, 0..1. Leaves air around it. */
  fill?: number
  /** Shadow opacity 0..1. */
  shadow?: number
  /** Output JPEG quality. */
  quality?: number
}

const DEFAULTS: Required<CompositeOptions> = { fill: 0.86, shadow: 0.42, quality: 90 }

type Box = { left: number; top: number; width: number; height: number }

/** The region in pixels, clamped to the canvas so an edge-drawn box cannot overflow. */
export function regionToBox(region: Region, width: number, height: number): Box {
  const left = Math.min(width - 1, Math.max(0, Math.round(region.x * width)))
  const top = Math.min(height - 1, Math.max(0, Math.round(region.y * height)))
  return {
    left,
    top,
    width: Math.max(1, Math.min(Math.round(region.w * width), width - left)),
    height: Math.max(1, Math.min(Math.round(region.h * height), height - top)),
  }
}

/** Relative luminance of a mean RGB, 0..255. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Brightness factor for the product so it reads as lit by the same room. A dark scene
 * pulls the product down; a bright one lifts it a little. Clamped so a white product on
 * a night shot still looks like a product and not a grey smudge.
 */
export function brightnessFor(sceneLuminance: number): number {
  const factor = 0.55 + sceneLuminance / 300
  return Math.min(1.12, Math.max(0.72, Number(factor.toFixed(3))))
}

/**
 * Composites `asset` into `region` of `image`. Pure with respect to storage: bytes in,
 * bytes out, so it is unit-testable without the engine around it.
 */
export async function compositeProduct(
  imageBytes: Buffer,
  assetBytes: Buffer,
  region: Region,
  options: CompositeOptions = {},
): Promise<{ output: Buffer; placed: Box; brightness: number }> {
  const opts = { ...DEFAULTS, ...options }

  // Auto-orient first: phone photos carry EXIF rotation, and the participant chose the
  // region on the displayed (oriented) image.
  const base = sharp(imageBytes).rotate()
  const meta = await base.metadata()
  const width = meta.width
  const height = meta.height
  if (!width || !height) throw new Error('Could not read image dimensions')

  const box = regionToBox(region, width, height)

  // Scene brightness under the region decides how the product is lit.
  const stats = await base.clone().extract(box).stats()
  const [r, g, b] = stats.channels
  const sceneLum = luminance(r?.mean ?? 128, g?.mean ?? 128, b?.mean ?? 128)
  const brightness = brightnessFor(sceneLum)

  // Trim transparent margins so the product, not its canvas, is what gets sized.
  let product = sharp(assetBytes).ensureAlpha()
  try {
    const trimmed = await product.clone().trim({ threshold: 8 }).toBuffer()
    product = sharp(trimmed).ensureAlpha()
  } catch {
    // A fully opaque or single-colour asset cannot be trimmed; use it as-is.
  }

  const target = {
    width: Math.max(1, Math.round(box.width * opts.fill)),
    height: Math.max(1, Math.round(box.height * opts.fill)),
  }

  const productPng = await product
    .resize({ width: target.width, height: target.height, fit: 'inside', withoutEnlargement: false })
    .modulate({ brightness, saturation: 0.96 })
    .png()
    .toBuffer()
  const productMeta = await sharp(productPng).metadata()
  const pw = productMeta.width ?? target.width
  const ph = productMeta.height ?? target.height

  // Products sit on surfaces: anchor to the bottom-centre of the chosen region.
  const placed: Box = {
    left: Math.max(0, Math.min(width - pw, box.left + Math.round((box.width - pw) / 2))),
    top: Math.max(0, Math.min(height - ph, box.top + box.height - ph - Math.round(box.height * (1 - opts.fill) * 0.35))),
    width: pw,
    height: ph,
  }

  // The shadow is the product's own silhouette: black, alpha scaled down, blurred,
  // offset down and to the right, drawn on a full-size canvas so blur can bleed past
  // the product's own bounds without a clipping error.
  const alpha = await sharp(productPng).ensureAlpha().extractChannel('alpha').linear(opts.shadow, 0).toBuffer()
  const silhouette = await sharp({
    create: { width: pw, height: ph, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer()

  const shadowOffset = { dx: Math.round(pw * 0.05), dy: Math.round(ph * 0.04) }
  const shadowCanvas = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: silhouette,
        left: Math.max(0, Math.min(width - pw, placed.left + shadowOffset.dx)),
        top: Math.max(0, Math.min(height - ph, placed.top + shadowOffset.dy)),
      },
    ])
    .png()
    .toBuffer()
  const shadow = await sharp(shadowCanvas).blur(Math.max(1, pw * 0.02)).png().toBuffer()

  const output = await base
    .clone()
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: productPng, left: placed.left, top: placed.top },
    ])
    .jpeg({ quality: opts.quality, mozjpeg: true })
    .toBuffer()

  return { output, placed, brightness }
}

export class LocalCompositeEngine implements PlacementEngine {
  readonly name = 'local-composite'

  constructor(private readonly options: CompositeOptions = {}) {}

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
    if (!args.imagePath) throw new Error('No original image to place into')
    if (!args.assetPath) throw new Error('No asset to place')

    const [image, asset] = await Promise.all([get(args.imagePath), get(args.assetPath)])
    const { output, placed, brightness } = await compositeProduct(image, asset, args.region, this.options)

    const versionId = randomToken(6).toLowerCase()
    const resultPath = paths.version(args.placementId, versionId, 'jpg')
    await put(resultPath, output, 'image/jpeg')

    return {
      resultPath,
      engine: this.name,
      params: { region: args.region, assetPath: args.assetPath, placed, brightness, ...args.params },
      deferred: false,
    }
  }
}
