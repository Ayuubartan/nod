/**
 * HostedInpaintEngine — docs/06 section 6 implementation 2, docs/09 M5 task 1:
 * "hosted image-editing/inpainting API with mask + reference asset. Choose the provider
 *  at build time; keep it behind the interface."
 *
 * The provider is chosen by `INPAINT_PROVIDER`. The request shape differs per provider,
 * so each one is a small adapter; everything else — building the mask from the chosen
 * region, storing the result, writing the PlacementVersion — is shared and provider
 * agnostic.
 *
 * When it succeeds the ops generation queue becomes review-only: `render` returns a
 * finished image rather than deferring, so `submitPosition` moves the placement straight
 * to PARTICIPANT_REVIEW. When it fails, the placement falls back to the ops queue rather
 * than failing the participant — a model outage must not cost someone their 48 hours.
 */

import 'server-only'
import sharp from 'sharp'
import { get, paths, put } from '@/lib/storage'
import { randomToken } from '@/lib/crypto'
import { heuristicRegions } from '@/lib/regions'
import type { PlacementEngine, Region, RenderResult } from './types'

export type InpaintProvider = 'openai' | 'stability' | 'replicate'

/**
 * The mask an inpainting API needs: the region to replace is transparent, the rest is
 * opaque. Built from the normalised region so it always matches the uploaded image's
 * actual dimensions.
 */
export async function buildMask(imageBytes: Buffer, region: Region): Promise<Buffer> {
  const { width, height } = await sharp(imageBytes).metadata()
  if (!width || !height) throw new Error('Could not read image dimensions')

  const box = {
    left: Math.max(0, Math.round(region.x * width)),
    top: Math.max(0, Math.round(region.y * height)),
    width: Math.max(1, Math.round(region.w * width)),
    height: Math.max(1, Math.round(region.h * height)),
  }
  // Keep the box inside the canvas even if the region was drawn to the edge.
  box.width = Math.min(box.width, width - box.left)
  box.height = Math.min(box.height, height - box.top)

  const hole = await sharp({
    create: { width: box.width, height: box.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer()

  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .composite([{ input: hole, left: box.left, top: box.top, blend: 'dest-out' }])
    .png()
    .toBuffer()
}

/**
 * The instruction given to the model. Written to describe a photograph, not an advert:
 * the whole product thesis is that the placement looks like it was already there.
 */
export function buildPrompt(assetName: string, regionLabel?: string): string {
  const where = regionLabel === 'centre' ? 'in the centre of the scene' : `in the ${regionLabel ?? 'marked'} area`
  return [
    `Place the product "${assetName}" naturally ${where}.`,
    'Match the existing lighting, white balance, shadow direction and depth of field.',
    'It should look like it was in the original photograph — not a sticker, not a logo overlay,',
    'no added text, no watermark, no border. Keep everything outside the masked area unchanged.',
  ].join(' ')
}

type AdapterArgs = {
  image: Buffer
  mask: Buffer
  asset: Buffer
  prompt: string
  signal: AbortSignal
}

/**
 * Provider adapters. Each returns raw image bytes.
 *
 * VERIFIED: not yet against any provider's live docs. docs/06 requires reading the
 * chosen provider's current reference and recording the date and URL here before this
 * is enabled in production. The endpoints below are configurable precisely so that
 * check is a config change, not a rewrite.
 */
const ADAPTERS: Record<InpaintProvider, (args: AdapterArgs) => Promise<Buffer>> = {
  async openai({ image, mask, prompt, signal }) {
    const endpoint = process.env.INPAINT_ENDPOINT ?? 'https://api.openai.com/v1/images/edits'
    const form = new FormData()
    form.append('model', process.env.INPAINT_MODEL ?? 'gpt-image-1')
    form.append('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'image.png')
    form.append('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png')
    form.append('prompt', prompt)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.INPAINT_API_KEY ?? ''}` },
      body: form,
      signal,
    })
    if (!response.ok) throw new Error(`Inpaint request failed: ${response.status}`)

    const body = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
    const first = body.data?.[0]
    if (first?.b64_json) return Buffer.from(first.b64_json, 'base64')
    if (first?.url) return Buffer.from(await (await fetch(first.url, { signal })).arrayBuffer())
    throw new Error('Inpaint response contained no image')
  },

  async stability({ image, mask, prompt, signal }) {
    const endpoint =
      process.env.INPAINT_ENDPOINT ?? 'https://api.stability.ai/v2beta/stable-image/edit/inpaint'
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'image.png')
    form.append('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png')
    form.append('prompt', prompt)
    form.append('output_format', 'png')

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.INPAINT_API_KEY ?? ''}`,
        accept: 'image/*',
      },
      body: form,
      signal,
    })
    if (!response.ok) throw new Error(`Inpaint request failed: ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  },

  async replicate({ image, mask, prompt, signal }) {
    const endpoint = process.env.INPAINT_ENDPOINT ?? 'https://api.replicate.com/v1/predictions'
    const version = process.env.INPAINT_MODEL
    if (!version) throw new Error('INPAINT_MODEL must name the Replicate model version')

    const start = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.INPAINT_API_KEY ?? ''}`,
        'content-type': 'application/json',
        prefer: 'wait',
      },
      body: JSON.stringify({
        version,
        input: {
          image: `data:image/png;base64,${image.toString('base64')}`,
          mask: `data:image/png;base64,${mask.toString('base64')}`,
          prompt,
        },
      }),
      signal,
    })
    if (!start.ok) throw new Error(`Inpaint request failed: ${start.status}`)

    const body = (await start.json()) as { output?: string | string[]; status?: string }
    const url = Array.isArray(body.output) ? body.output[0] : body.output
    if (!url) throw new Error(`Inpaint returned no output (status ${body.status})`)
    return Buffer.from(await (await fetch(url, { signal })).arrayBuffer())
  },
}

export class HostedInpaintEngine implements PlacementEngine {
  readonly name: string

  constructor(
    private readonly provider: InpaintProvider = (process.env.INPAINT_PROVIDER as InpaintProvider) ?? 'openai',
    private readonly timeoutMs = Number(process.env.INPAINT_TIMEOUT_MS ?? 90_000),
  ) {
    this.name = `hosted-inpaint:${this.provider}`
  }

  static isConfigured(): boolean {
    return Boolean(process.env.INPAINT_API_KEY && process.env.INPAINT_PROVIDER)
  }

  async candidates(): Promise<Region[]> {
    // Region proposal stays heuristic until Parallel replaces it; the model is only
    // asked to render, never to decide where the brand goes. That choice is the
    // participant's, and it is also the training label (docs/06 section 6).
    return heuristicRegions()
  }

  async render(args: {
    placementId: string
    imagePath: string
    region: Region
    assetPath: string
    params?: Record<string, unknown>
  }): Promise<RenderResult> {
    const adapter = ADAPTERS[this.provider]
    if (!adapter) throw new Error(`Unknown inpaint provider: ${this.provider}`)
    if (!process.env.INPAINT_API_KEY) throw new Error('INPAINT_API_KEY is not set')

    const [image, asset] = await Promise.all([get(args.imagePath), get(args.assetPath)])

    // Normalise to PNG: every provider wants a consistent format, and the mask has to
    // match the image byte-for-byte in dimensions.
    const png = await sharp(image).png().toBuffer()
    const mask = await buildMask(png, args.region)

    const assetName = String(args.params?.assetName ?? 'the product')
    const prompt = buildPrompt(assetName, args.region.label)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const output = await adapter({ image: png, mask, asset, prompt, signal: controller.signal })

      const versionId = randomToken(6).toLowerCase()
      const resultPath = paths.version(args.placementId, versionId, 'png')
      await put(resultPath, output, 'image/png')

      return {
        resultPath,
        engine: this.name,
        params: { region: args.region, prompt, provider: this.provider },
        deferred: false,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
