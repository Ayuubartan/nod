/**
 * Demo artwork — generated, never downloaded. The seed writes these so the whole
 * placement flow (photo → position → composite) is walkable on a fresh checkout with no
 * brand assets and no photo library. Shapes only: SVG text depends on installed fonts
 * and renders differently on every machine.
 */

import sharp from 'sharp'

export type BagPalette = { body: string; seal: string; label: string; emblem: string; accent: string }

export const BAG_PALETTES: Record<'autumn' | 'winter', BagPalette> = {
  autumn: { body: '#3b2a20', seal: '#2a1c14', label: '#f3e9d8', emblem: '#c8642a', accent: '#3b2a20' },
  winter: { body: '#1e3a5f', seal: '#152a45', label: '#dfe9f5', emblem: '#f0b429', accent: '#1e3a5f' },
}

/** A 500g coffee bag with a label and an emblem, on a transparent background. */
export async function productBag(palette: BagPalette = BAG_PALETTES.autumn): Promise<Buffer> {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${palette.body}" stop-opacity="0.85"/>
      <stop offset="0.35" stop-color="${palette.body}"/>
      <stop offset="1" stop-color="${palette.body}" stop-opacity="0.75"/>
    </linearGradient>
  </defs>
  <rect x="100" y="88" width="400" height="70" rx="14" fill="${palette.seal}"/>
  <rect x="80" y="130" width="440" height="640" rx="34" fill="url(#body)"/>
  <rect x="104" y="150" width="26" height="600" rx="13" fill="#ffffff" opacity="0.07"/>
  <rect x="150" y="330" width="300" height="240" rx="22" fill="${palette.label}"/>
  <circle cx="300" cy="420" r="58" fill="${palette.emblem}"/>
  <circle cx="300" cy="420" r="30" fill="${palette.label}"/>
  <rect x="205" y="500" width="190" height="16" rx="8" fill="${palette.accent}"/>
  <rect x="235" y="528" width="130" height="10" rx="5" fill="${palette.accent}" opacity="0.6"/>
  <rect x="120" y="740" width="360" height="22" rx="10" fill="${palette.seal}"/>
</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** A round emblem — the "logo" asset. */
export async function productLogo(palette: BagPalette = BAG_PALETTES.autumn): Promise<Buffer> {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <circle cx="256" cy="256" r="230" fill="${palette.emblem}"/>
  <circle cx="256" cy="256" r="176" fill="${palette.label}"/>
  <rect x="186" y="196" width="122" height="132" rx="26" fill="${palette.body}"/>
  <path d="M308 224 h34 a30 30 0 0 1 0 60 h-34 z" fill="none" stroke="${palette.body}" stroke-width="22"/>
  <rect x="176" y="344" width="160" height="16" rx="8" fill="${palette.body}"/>
</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** A kitchen-table scene, portrait 4:5 — the kind of photo a participant already takes. */
export async function demoKitchen(): Promise<Buffer> {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ece4d8"/>
      <stop offset="1" stop-color="#d7ccbd"/>
    </linearGradient>
    <linearGradient id="table" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9a7a58"/>
      <stop offset="1" stop-color="#6f5438"/>
    </linearGradient>
    <linearGradient id="light" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff9ee" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#fff9ee" stop-opacity="0.2"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="1500" fill="url(#wall)"/>
  <rect x="120" y="120" width="520" height="620" rx="18" fill="#f7f1e6"/>
  <rect x="150" y="150" width="220" height="270" fill="#dbe7ee"/>
  <rect x="410" y="150" width="200" height="270" fill="#d3e1ea"/>
  <rect x="150" y="450" width="220" height="260" fill="#d6e3ec"/>
  <rect x="410" y="450" width="200" height="260" fill="#cfdde7"/>
  <rect x="760" y="240" width="300" height="400" rx="10" fill="#c9bfae"/>
  <rect x="790" y="270" width="240" height="120" fill="#e6ded0"/>
  <rect x="790" y="410" width="240" height="200" fill="#e6ded0"/>
  <polygon points="0,1500 0,880 1200,830 1200,1500" fill="url(#table)"/>
  <polygon points="0,880 1200,830 1200,846 0,896" fill="#5a4229" opacity="0.5"/>
  <g opacity="0.14" stroke="#3b2a20" stroke-width="3">
    <line x1="0" y1="960" x2="1200" y2="905"/><line x1="0" y1="1050" x2="1200" y2="990"/>
    <line x1="0" y1="1150" x2="1200" y2="1085"/><line x1="0" y1="1260" x2="1200" y2="1190"/>
    <line x1="0" y1="1380" x2="1200" y2="1305"/>
  </g>
  <ellipse cx="260" cy="1110" rx="190" ry="70" fill="#000" opacity="0.18"/>
  <ellipse cx="250" cy="1090" rx="190" ry="70" fill="#f6f1e9"/>
  <ellipse cx="250" cy="1090" rx="130" ry="46" fill="#efe7db"/>
  <ellipse cx="960" cy="1210" rx="120" ry="44" fill="#000" opacity="0.16"/>
  <rect x="870" y="1040" width="180" height="160" rx="24" fill="#f1ece3"/>
  <ellipse cx="960" cy="1044" rx="90" ry="30" fill="#5b3b2a"/>
  <polygon points="0,0 700,0 0,900" fill="url(#light)" opacity="0.45"/>
</svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer()
}

/** A desk scene — the second upload in the walkthrough. */
export async function demoDesk(): Promise<Buffer> {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1500" viewBox="0 0 1200 1500">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e5e7ea"/>
      <stop offset="1" stop-color="#cfd3d8"/>
    </linearGradient>
    <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d9cdb8"/>
      <stop offset="1" stop-color="#b8a98f"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="1500" fill="url(#wall)"/>
  <rect x="300" y="200" width="620" height="420" rx="14" fill="#1f2328"/>
  <rect x="320" y="220" width="580" height="380" rx="8" fill="#2f6fe4" opacity="0.85"/>
  <rect x="560" y="620" width="100" height="90" fill="#3a3f45"/>
  <rect x="440" y="700" width="340" height="24" rx="12" fill="#3a3f45"/>
  <polygon points="0,1500 0,760 1200,740 1200,1500" fill="url(#desk)"/>
  <rect x="110" y="880" width="420" height="160" rx="10" fill="#f6f4ef"/>
  <rect x="140" y="910" width="300" height="12" rx="6" fill="#c9c4b8"/>
  <rect x="140" y="940" width="340" height="12" rx="6" fill="#c9c4b8"/>
  <rect x="140" y="970" width="220" height="12" rx="6" fill="#c9c4b8"/>
  <ellipse cx="900" cy="1180" rx="140" ry="52" fill="#000" opacity="0.15"/>
  <circle cx="330" cy="1240" r="60" fill="#2f6fe4" opacity="0.15"/>
</svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer()
}
