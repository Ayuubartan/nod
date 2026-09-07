/**
 * The local compositor is pure with respect to storage: bytes in, bytes out. These tests
 * pin the two properties the rest of the system relies on — the output is the same
 * canvas as the input, and nothing outside the chosen region changes (the media-match
 * verification check compares exactly those pixels).
 */

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { brightnessFor, compositeProduct, regionToBox } from '@/lib/integrations/composite'
import { BAG_PALETTES, productBag } from '@/lib/demo-art'

const WIDTH = 240
const HEIGHT = 300

/** A flat mid-grey scene with a darker "table" band across the bottom third. */
async function scene(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#9a9a9a"/>
    <rect y="${HEIGHT * 0.66}" width="${WIDTH}" height="${HEIGHT * 0.34}" fill="#4a3a2a"/>
  </svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer()
}

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const raw = await sharp(buf).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()
  return [raw[0]!, raw[1]!, raw[2]!]
}

describe('regionToBox', () => {
  it('maps normalised coordinates to pixels', () => {
    expect(regionToBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, 1000, 800)).toEqual({
      left: 100,
      top: 160,
      width: 500,
      height: 200,
    })
  })

  it('clamps a box drawn past the edge to the canvas', () => {
    const box = regionToBox({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 }, 1000, 800)
    expect(box.left + box.width).toBeLessThanOrEqual(1000)
    expect(box.top + box.height).toBeLessThanOrEqual(800)
    expect(box.width).toBeGreaterThan(0)
    expect(box.height).toBeGreaterThan(0)
  })
})

describe('brightnessFor', () => {
  it('darkens the product in a dark scene and lifts it in a bright one, within limits', () => {
    expect(brightnessFor(0)).toBe(0.72)
    expect(brightnessFor(255)).toBe(1.12)
    expect(brightnessFor(120)).toBeGreaterThan(brightnessFor(60))
  })
})

describe('compositeProduct', () => {
  const region = { x: 0.55, y: 0.5, w: 0.4, h: 0.4 }

  it('keeps the canvas size and places the product inside the region', async () => {
    const { output, placed } = await compositeProduct(await scene(), await productBag(BAG_PALETTES.autumn), region)
    const meta = await sharp(output).metadata()
    expect(meta.width).toBe(WIDTH)
    expect(meta.height).toBe(HEIGHT)

    const box = regionToBox(region, WIDTH, HEIGHT)
    expect(placed.left).toBeGreaterThanOrEqual(box.left)
    expect(placed.top).toBeGreaterThanOrEqual(box.top)
    expect(placed.left + placed.width).toBeLessThanOrEqual(box.left + box.width)
    expect(placed.top + placed.height).toBeLessThanOrEqual(box.top + box.height)
  })

  it('changes pixels inside the region and leaves the rest of the photo alone', async () => {
    const before = await scene()
    const { output, placed } = await compositeProduct(before, await productBag(BAG_PALETTES.autumn), region)

    // Centre of the product: the bag body is dark brown on a grey scene.
    const cx = placed.left + Math.round(placed.width / 2)
    const cy = placed.top + Math.round(placed.height / 2)
    const inside = await pixel(output, cx, cy)
    const insideBefore = await pixel(before, cx, cy)
    const insideDiff = inside.reduce((sum, c, i) => sum + Math.abs(c - insideBefore[i]!), 0)
    expect(insideDiff).toBeGreaterThan(60)

    // Far corners, well outside the region and its shadow: identical within JPEG noise.
    for (const [x, y] of [
      [4, 4],
      [WIDTH - 5, 4],
      [4, HEIGHT - 5],
      [Math.round(WIDTH * 0.2), Math.round(HEIGHT * 0.3)],
    ] as const) {
      const a = await pixel(before, x, y)
      const b = await pixel(output, x, y)
      const diff = a.reduce((sum, c, i) => sum + Math.abs(c - b[i]!), 0)
      expect(diff, `pixel ${x},${y}`).toBeLessThan(12)
    }
  })

  it('refuses an image it cannot read', async () => {
    await expect(compositeProduct(Buffer.from('not an image'), await productBag(), region)).rejects.toThrow()
  })
})
