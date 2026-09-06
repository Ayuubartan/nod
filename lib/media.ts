/**
 * Perceptual hashing — used twice in the product, for two different jobs:
 *
 *   1. P-02 pre-check: the same image may not be claimed twice (edge case 6).
 *   2. Verification check 3: the published media must match the approved media.
 *
 * dHash (difference hash) over a 9x8 greyscale reduction: 64 bits, robust to
 * re-encoding, resizing and the recompression Instagram applies on upload, which is
 * exactly the distortion we need to see through. It is not robust to crops or heavy
 * filters — that is deliberate, since those are also what a media mismatch looks like.
 */

import sharp from 'sharp'

export const HASH_BITS = 64

export async function perceptualHash(input: Buffer): Promise<string> {
  const { data } = await sharp(input)
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  let bits = ''
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col]!
      const right = data[row * 9 + col + 1]!
      bits += left > right ? '1' : '0'
    }
  }

  // 16 hex characters.
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error('Hashes must be the same length')
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    const xor = Number.parseInt(a[i]!, 16) ^ Number.parseInt(b[i]!, 16)
    distance += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1)
  }
  return distance
}

/** 1.0 = identical, 0.0 = every bit differs. Compared against LIMITS.mediaMatchThreshold. */
export function similarity(a: string, b: string): number {
  return 1 - hammingDistance(a, b) / HASH_BITS
}

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024

export type PreCheckResult =
  | { ok: true; hash: string; kind: 'image' | 'video' }
  | { ok: false; error: 'format' | 'size' }

/**
 * P-02 pre-check: format and size. Duplicate and brand safety are checked against the
 * database in lib/state/placement.ts, because they need campaign context.
 *
 * Video is hashed on its first frame, which is what a viewer actually sees in a feed.
 */
export async function preCheck(file: {
  mimeType: string
  bytes: number
  buffer: Buffer
}): Promise<PreCheckResult> {
  if (file.bytes > MAX_UPLOAD_BYTES) return { ok: false, error: 'size' }

  const isImage = (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.mimeType)
  const isVideo = (ACCEPTED_VIDEO_TYPES as readonly string[]).includes(file.mimeType)
  if (!isImage && !isVideo) return { ok: false, error: 'format' }

  if (isVideo) {
    // DECISION: the pilot hashes video by its poster frame only. Extracting a frame
    // needs ffmpeg, which is not in the Vercel runtime, so the client sends a captured
    // first frame alongside the video and that is what arrives here as `buffer`.
    return { ok: true, hash: await perceptualHash(file.buffer), kind: 'video' }
  }

  return { ok: true, hash: await perceptualHash(file.buffer), kind: 'image' }
}

/**
 * Brand-safety stub — docs/09 M2 task 6: "brand-safety as a stub returning OK unless a
 * flagged keyword is in the campaign exclusions". Real classification is post-pilot.
 */
export function brandSafetyCheck(args: {
  caption?: string | null
  accountCategories: string[]
  exclusions: string[]
  brandSafety: string[]
}): { ok: boolean; reason?: string } {
  const blocked = [...args.exclusions, ...args.brandSafety].map((s) => s.toLowerCase())
  if (blocked.length === 0) return { ok: true }

  const haystack = [...(args.caption ? [args.caption] : []), ...args.accountCategories]
    .join(' ')
    .toLowerCase()

  const hit = blocked.find((term) => term.length > 0 && haystack.includes(term))
  return hit ? { ok: false, reason: hit } : { ok: true }
}

/**
 * Disclosure check — verification check 2, the payable condition (CLAUDE.md rule 5).
 *
 * Swedish marketing law wants the disclosure clear and up front, so the check is:
 * the required word appears within the first line, not buried among hashtags.
 */
export function disclosurePresent(caption: string | null | undefined, requiredText: string): boolean {
  if (!caption) return false

  const firstLine = caption.split('\n')[0]!.toLowerCase()
  const normalisedFirstLine = firstLine.replace(/\s+/g, ' ').trim()

  // The exact issued text is the strongest signal.
  if (normalisedFirstLine.includes(requiredText.toLowerCase().replace(/\s+/g, ' ').trim())) return true

  // Otherwise accept the legally required marker at the start of the caption.
  return /^(reklam|annons|ad)\b/.test(normalisedFirstLine)
}
