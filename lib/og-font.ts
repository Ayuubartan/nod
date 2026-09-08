/**
 * Space Grotesk 700 for `next/og` images. Satori ships no bold face, so without this
 * the wordmark and headline render in a thin default. Fetched once per instance from
 * Google Fonts (the same source `next/font` uses at build time); when the fetch fails
 * the image still renders, just lighter.
 */
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&display=swap'

let cached: Promise<ArrayBuffer | null> | undefined

export function spaceGroteskBold(): Promise<ArrayBuffer | null> {
  if (cached) return cached
  const loading = (async () => {
    try {
      const css = await fetch(CSS_URL, {
        // An old UA gets a TTF/WOFF rather than the woff2 Satori cannot parse.
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:27.0) Gecko/20100101 Firefox/27.0' },
      }).then((r) => r.text())
      const url = css.match(/src: url\((https:[^)]+\.(?:ttf|woff))\)/)?.[1]
      if (!url) return null
      return await fetch(url).then((r) => r.arrayBuffer())
    } catch {
      return null
    }
  })()
  cached = loading
  return loading
}

/**
 * Options for `ImageResponse`: the font when we have it, nothing when we do not —
 * an empty `fonts` array makes Satori refuse to lay out at all.
 */
export async function ogFonts(): Promise<{ fonts?: { name: string; data: ArrayBuffer; weight: 700; style: 'normal' }[] }> {
  const data = await spaceGroteskBold()
  return data ? { fonts: [{ name: 'Space Grotesk', data, weight: 700, style: 'normal' }] } : {}
}
