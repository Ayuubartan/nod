/**
 * NOD intro video — a ~79 s explainer rendered from code.
 *
 * Every frame is an SVG string (brand colours, real renders from `.storage/`) rasterised
 * with sharp and piped raw into ffmpeg; the narration comes from `narration.json` via
 * `tts.ps1` (Windows SAPI) and is mixed in with a soft synthesised pad.
 *
 *   pnpm video            -> docs/media/nod-intro.mp4 (1920x1080, 30 fps)
 *   pnpm video --quick    -> half size, 15 fps, for a fast look
 *   pnpm video --frame 12.5 --png out.png   -> one frame at t=12.5 s, for checking layout
 *
 * Needs ffmpeg on PATH and, for the voice, the WAVs from tts.ps1 (music-only track otherwise).
 */

import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import sharp from 'sharp'

// ---------- arguments ----------

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const QUICK = flag('--quick')
const SCALE = QUICK ? 0.5 : 1
const FPS = QUICK ? 15 : 30
const W = 1920
const H = 1080
const OUT = opt('--out', 'docs/media/nod-intro.mp4')
const BUILD = 'scripts/intro-video/.build'
const VO_DIR = path.join(BUILD, 'vo')
const VO_LEAD = 0.45 // seconds between a scene starting and its narration

// ---------- brand ----------

const BG = '#faf7f2'
const INK = '#14110f'
const INK2 = '#5c554d'
const INK3 = '#a39b91'
const LINE = '#e8e2da'
const AMBER = '#f5a524'
const AMBER_DK = '#c77e0a'
const AMBER_SOFT = '#fbe3b5'
const GREEN = '#1f9d6b'
const RED = '#d6453d'
const BLUE = '#2f6fe4'
const WHITE = '#ffffff'

const DISPLAY = 'Bahnschrift, Segoe UI, sans-serif'
const SANS = 'Segoe UI, sans-serif'
const MONO = 'Cascadia Mono, Consolas, monospace'

// ---------- assets ----------

function dataUri(file) {
  const ext = path.extname(file).slice(1).toLowerCase()
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

const IMG = {
  kitchen: dataUri('.storage/demo/kitchen.jpg'),
  kitchenWinter: dataUri('.storage/versions/cmtr3bnjh0009cg1sq0mgxhdr/blwgfyzz.jpg'),
  annaAutumn: dataUri('.storage/versions/cmtr2nt2j001bcg7g24avcvny/jppuvd-3.jpg'),
  annaWinter: dataUri('.storage/versions/cmtr2nt2j001bcg7g24avcvny/pkyuvcor.jpg'),
  shelfAutumn: dataUri('.storage/versions/cmtr2nter001pcg7gjq2r87xh/-lu2ijzs.jpg'),
  shelfWinter: dataUri(path.join(BUILD, 'img/shelf-winter.jpg')),
  sillAutumn: dataUri('.storage/versions/cmtr2ntmn0025cg7g0tjl59u5/kew_p1gg.jpg'),
  sillWinter: dataUri(path.join(BUILD, 'img/sill-winter.jpg')),
  bagAutumn: dataUri('.storage/assets/seed-campaign-live/seed-asset-bag-seed-campaign-live.png'),
  bagWinter: dataUri('.storage/assets/seed-campaign-live/seed-asset-winter-seed-campaign-live.png'),
  logo: dataUri('.storage/assets/seed-campaign-live/seed-asset-logo-seed-campaign-live.png'),
}

// ---------- easing ----------

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const easeOut = (t) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a, b, p) => a + (b - a) * p
/** 0 → 1 over `dur` seconds from `start`. */
const ramp = (t, start, dur = 0.5, ease = easeOut) => ease(clamp((t - start) / dur))
/** 1 while inside [start, end], with fades at both edges. */
const win = (t, start, end, fade = 0.35) =>
  t < start || t > end ? 0 : Math.min(ramp(t, start, fade), 1 - ramp(t, end - fade, fade, easeInOut))
/** A quick 1 → 1.06 → 1 scale pulse starting at `start`. */
const pulse = (t, start, dur = 0.5) => {
  const p = clamp((t - start) / dur)
  return 1 + 0.06 * Math.sin(p * Math.PI)
}

// ---------- svg primitives ----------

let uid = 0
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmt = (n) => Math.round(n).toLocaleString('sv-SE').replace(/ /g, ' ')

function text(x, y, str, o = {}) {
  const { size = 40, weight = 400, fill = INK, family = SANS, anchor = 'start', opacity = 1, ls = 0 } = o
  if (opacity <= 0) return ''
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}"${ls ? ` letter-spacing="${ls}"` : ''}>${esc(str)}</text>`
}

function rect(x, y, w, h, o = {}) {
  const { fill = 'none', r = 0, stroke, sw = 2, opacity = 1, dash } = o
  if (opacity <= 0 || w <= 0 || h <= 0) return ''
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''} opacity="${opacity}"/>`
}

function circle(cx, cy, r, o = {}) {
  const { fill = INK, opacity = 1, stroke, sw = 2 } = o
  if (opacity <= 0) return ''
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''} opacity="${opacity}"/>`
}

function group(inner, o = {}) {
  const { opacity = 1, transform = '' } = o
  if (opacity <= 0 || !inner) return ''
  return `<g opacity="${opacity}"${transform ? ` transform="${transform}"` : ''}>${inner}</g>`
}

/** Scale about a point — SVG transforms compose right-to-left. */
const scaleAt = (s, cx, cy) => `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`

/** Fade in and rise `dy` px from `start`. */
function fadeUp(t, start, inner, o = {}) {
  const { dur = 0.6, dy = 28 } = o
  const p = ramp(t, start, dur)
  if (p <= 0) return ''
  return group(inner, { opacity: p, transform: `translate(0 ${(1 - p) * dy})` })
}

function image(href, x, y, w, h, o = {}) {
  const { r = 0, opacity = 1, clipW } = o
  if (opacity <= 0) return ''
  const id = `c${uid++}`
  const cw = clipW === undefined ? w : clipW
  if (cw <= 0) return ''
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="${r}"/></clipPath><image clip-path="url(#${id})" href="${href}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" opacity="${opacity}"/>`
}

/** Approximate text width for pill sizing; Segoe UI is ~0.53 em per character. */
const tw = (str, size, weight = 400) => str.length * size * (weight >= 600 ? 0.58 : 0.53)

function chip(x, y, label, o = {}) {
  const { fill = AMBER, color = INK, size = 24, weight = 600, opacity = 1, pad = 18, anchor = 'start', stroke } = o
  if (opacity <= 0) return ''
  const w = tw(label, size, weight) + pad * 2
  const h = size * 1.75
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x
  return group(
    rect(left, y, w, h, { fill, r: h / 2, stroke, sw: 2 }) +
      text(left + w / 2, y + h / 2 + size * 0.36, label, { size, weight, fill: color, anchor: 'middle' }),
    { opacity },
  )
}

function card(x, y, w, h, inner = '', o = {}) {
  const { opacity = 1, fill = WHITE } = o
  return group(rect(x, y, w, h, { fill, r: 28, stroke: LINE, sw: 2 }) + inner, { opacity })
}

function check(cx, cy, r = 18, o = {}) {
  const { fill = GREEN, opacity = 1 } = o
  return group(
    circle(cx, cy, r, { fill }) +
      `<path d="M${cx - r * 0.45} ${cy} l${r * 0.3} ${r * 0.3} l${r * 0.6} ${-r * 0.6}" stroke="${WHITE}" stroke-width="${r * 0.22}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    { opacity },
  )
}

function wordmark(x, y, size, o = {}) {
  return text(x, y, 'NOD', { size, weight: 700, family: DISPLAY, ls: -size * 0.02, ...o })
}

/** Top strip: wordmark left, chapter label right. */
function nav(t, chapter) {
  const p = ramp(t, 0.1, 0.5)
  return group(
    wordmark(120, 92, 44) +
      text(W - 120, 90, chapter, { size: 26, fill: INK3, anchor: 'end', weight: 600, ls: 1 }),
    { opacity: p },
  )
}

/** A phone showing a post: handle on top, photo, disclosure and caption below. */
function phone(x, y, w, h, href, o = {}) {
  const { handle = '@jonas_gym', disclosure = 'Reklam · i samarbete med Kaffeklubben', caption = 'Söndagsfika ☕', views, opacity = 1 } = o
  if (opacity <= 0) return ''
  const bezel = 14
  const sx = x + bezel
  const sy = y + bezel
  const sw = w - bezel * 2
  const sh = h - bezel * 2
  const top = 76
  const photoH = Math.round(sw * 1.25)
  let inner = rect(x, y, w, h, { fill: INK, r: 56 }) + rect(sx, sy, sw, sh, { fill: WHITE, r: 44 })
  // header
  inner += circle(sx + 44, sy + top / 2, 20, { fill: AMBER_SOFT }) + text(sx + 76, sy + top / 2 + 9, handle, { size: 24, weight: 700 })
  inner += text(sx + sw - 28, sy + top / 2 + 9, '···', { size: 26, fill: INK3, anchor: 'end' })
  // photo
  inner += image(href, sx, sy + top, sw, photoH)
  // disclosure + caption
  const by = sy + top + photoH + 22
  inner += chip(sx + 24, by, disclosure, { fill: AMBER_SOFT, color: AMBER_DK, size: 17, weight: 700, pad: 12 })
  inner += text(sx + 24, by + 74, caption, { size: 22, weight: 600 })
  if (views !== undefined) inner += text(sx + 24, by + 108, `${fmt(views)} visningar`, { size: 19, fill: INK3 })
  return group(inner, { opacity })
}

// ---------- scenes ----------

const scenes = [
  {
    id: 's1-logo',
    dur: 4.2,
    draw(t) {
      const p = ramp(t, 0.1, 0.9)
      return (
        group(wordmark(W / 2, 600, 300, { anchor: 'middle' }), {
          opacity: p,
          transform: scaleAt(lerp(0.92, 1, p), W / 2, 520),
        }) +
        circle(W / 2 + 318, 588, 22, { fill: AMBER, opacity: ramp(t, 0.7, 0.4) }) +
        fadeUp(t, 1.2, text(W / 2, 728, 'Posta som vanligt.', { size: 64, anchor: 'middle', fill: INK2 })) +
        fadeUp(t, 2.0, text(W / 2, 800, 'Post as usual. Get paid.', { size: 36, anchor: 'middle', fill: INK3 }))
      )
    },
  },
  {
    id: 's2-problem',
    dur: 8.6,
    draw(t) {
      const lines = [
        ['Ads interrupt.', 0.3, INK],
        ['Influencers cost a fortune.', 2.2, INK],
        ['Everyone else posts for free.', 4.5, AMBER_DK],
      ]
      let s = nav(t, 'THE PROBLEM')
      lines.forEach(([str, at, fill], i) => {
        s += fadeUp(t, at, text(160, 440 + i * 150, str, { size: 96, weight: 700, family: DISPLAY, fill }))
      })
      const u = ramp(t, 7.0, 0.8)
      s += rect(160, 780, 1240 * u, 10, { fill: AMBER, r: 5 })
      return s
    },
  },
  {
    id: 's3-idea',
    dur: 8.6,
    draw(t) {
      let s = nav(t, 'THE IDEA')
      const slide = ramp(t, 0.2, 1.0)
      const views = t < 4.6 ? undefined : Math.round(1000 * ramp(t, 4.6, 2.2))
      s += phone(lerp(1330, 1250, slide), 120, 500, 860, IMG.kitchenWinter, { opacity: slide, views })
      s += fadeUp(t, 0.9, text(160, 420, 'Real products.', { size: 92, weight: 700, family: DISPLAY }))
      s += fadeUp(t, 2.1, text(160, 540, 'In real posts.', { size: 92, weight: 700, family: DISPLAY }))
      s += fadeUp(t, 4.4, text(160, 660, 'Paid per verified view.', { size: 92, weight: 700, family: DISPLAY, fill: AMBER_DK }))
      s += fadeUp(
        t,
        5.6,
        text(160, 760, 'No briefs. No scripts. The post you were going to make anyway.', { size: 32, fill: INK2 }),
      )
      const payout = ramp(t, 6.2, 0.5)
      s += chip(1250 + 250, 1000 - 4, '+ 43 kr', { fill: GREEN, color: WHITE, size: 26, anchor: 'middle', opacity: payout })
      return s
    },
  },
  {
    id: 's4-flow',
    dur: 14.2,
    draw(t) {
      let s = nav(t, 'FOR CREATORS')
      const steps = ['Verify with BankID', 'Pick a campaign', 'Upload your photo', 'Approve & publish']
      const starts = [0.3, 2.0, 3.9, 8.3]
      const active = starts.filter((at) => t >= at).length - 1
      const hints = [
        ['Verified once.', 'One real person per account.'],
        ['You choose.', 'Nothing is assigned to you.'],
        ['The photo you’d post anyway.', 'NOD places the product in seconds.'],
        ['One tap.', 'Your account. Your post. Your money.'],
      ]
      // step rail
      steps.forEach((label, i) => {
        const x = 160 + i * 410
        const on = i === active
        const p = ramp(t, 0.2 + i * 0.12, 0.5)
        s += group(
          chip(x, 940, `${i + 1}  ${label}`, {
            fill: on ? AMBER : WHITE,
            color: on ? INK : INK2,
            size: 24,
            weight: 700,
            pad: 26,
            stroke: on ? AMBER : LINE,
          }),
          { opacity: p },
        )
      })
      // hint column
      if (active >= 0) {
        const at = starts[active]
        const [h1, h2] = hints[active]
        const end = active < 3 ? starts[active + 1] : Infinity
        const o = Math.min(ramp(t, at + 0.1, 0.5), end === Infinity ? 1 : 1 - ramp(t, end - 0.3, 0.3))
        s += group(
          text(160, 400, h1, { size: 48, weight: 700, family: DISPLAY }) + text(160, 452, h2, { size: 28, fill: INK2 }),
          { opacity: o },
        )
      }
      // stage
      const cx = 1180
      // A: BankID card
      {
        const o = win(t, 0.3, 2.0, 0.3)
        const x = cx - 300
        const y = 330
        s += card(
          x,
          y,
          600,
          260,
          rect(x + 40, y + 52, 74, 90, { fill: '#193e6a', r: 16 }) +
            text(x + 77, y + 112, 'ID', { size: 40, weight: 700, family: DISPLAY, fill: WHITE, anchor: 'middle' }) +
            text(x + 150, y + 92, 'BankID', { size: 44, weight: 700, family: DISPLAY }) +
            text(x + 150, y + 134, 'Anna Svensson · 1994', { size: 26, fill: INK2 }) +
            check(x + 150 + 22, y + 192, 20) +
            text(x + 150 + 56, y + 201, 'Verified · personnummer never stored', { size: 22, fill: INK2 }),
          { opacity: o },
        )
      }
      // B: campaign card
      {
        const o = win(t, 2.0, 3.9, 0.3)
        const x = cx - 380
        const y = 330
        s += card(
          x,
          y,
          760,
          240,
          text(x + 40, y + 62, 'Kaffeklubben', { size: 22, fill: INK3, weight: 600 }) +
            text(x + 40, y + 108, 'Kaffeklubben — hösten', { size: 40, weight: 700, family: DISPLAY }) +
            text(x + 720, y + 108, 'Du får ~58 kr', { size: 34, family: MONO, fill: AMBER_DK, anchor: 'end', weight: 600 }) +
            rect(x + 40, y + 150, 680, 12, { fill: LINE, r: 6 }) +
            rect(x + 40, y + 150, 680 * 0.99, 12, { fill: AMBER, r: 6 }) +
            text(x + 40, y + 200, '99 % av budgeten kvar · Går ut om 29 d', { size: 22, fill: INK3 }),
          { opacity: o },
        )
      }
      // C: photo → region → composite → approve → published
      {
        const o = ramp(t, 3.9, 0.7)
        const pw = 600
        const ph = 750
        const x = cx - pw / 2
        const y = 100 + (1 - o) * 30
        let inner = image(IMG.kitchen, x, y, pw, ph, { r: 32 })
        const wipe = ramp(t, 6.4, 1.3, easeInOut)
        inner += image(IMG.kitchenWinter, x, y, pw, ph, { r: 32, clipW: pw * wipe })
        if (wipe > 0 && wipe < 1) inner += rect(x + pw * wipe - 3, y, 6, ph, { fill: AMBER })
        // region
        const ro = win(t, 5.0, 6.7, 0.3)
        const r = { x: 0.08, y: 0.55, w: 0.4, h: 0.3 }
        inner += rect(x + r.x * pw, y + r.y * ph, r.w * pw, r.h * ph, { stroke: AMBER, sw: 5, dash: '16 12', r: 10, opacity: ro })
        inner += chip(x + r.x * pw, y + r.y * ph - 52, 'Här står den', { size: 20, opacity: ro, pad: 14 })
        // placed badge
        inner += chip(x + pw / 2, y + ph - 72, 'Placed by NOD · 0.2 s', {
          fill: INK,
          color: WHITE,
          size: 22,
          anchor: 'middle',
          opacity: win(t, 7.6, 8.5, 0.3),
        })
        // approve button
        {
          const bo = win(t, 8.7, 10.2, 0.3)
          const sc = pulse(t, 9.3)
          inner += group(
            rect(x + 60, y + ph - 110, pw - 120, 76, { fill: AMBER, r: 38 }) +
              text(x + pw / 2, y + ph - 60, 'Godkänn', { size: 30, weight: 700, anchor: 'middle' }),
            { opacity: bo, transform: scaleAt(sc, x + pw / 2, y + ph - 72) },
          )
        }
        // published
        inner += chip(x + pw / 2, y + ph - 152, 'Reklam · i samarbete med Kaffeklubben', {
          fill: AMBER_SOFT,
          color: AMBER_DK,
          size: 20,
          anchor: 'middle',
          opacity: ramp(t, 10.9, 0.5),
        })
        inner += chip(x + pw / 2, y + ph - 90, 'Published by you  ✓', {
          fill: GREEN,
          color: WHITE,
          size: 26,
          anchor: 'middle',
          opacity: ramp(t, 10.4, 0.5),
        })
        s += group(inner, { opacity: o })
      }
      return s
    },
  },
  {
    id: 's5-paid',
    dur: 8.2,
    draw(t) {
      let s = nav(t, 'GETTING PAID')
      // left: the checks
      {
        const x = 160
        const y = 200
        const items = [
          ['Views verified', 'Read from the platform, not self-reported', 0.4],
          ['Disclosure present', '“Reklam” is a payable condition', 2.0],
          ['Media matches', 'The post is the image you approved', 3.2],
        ]
        let inner = text(x + 48, y + 72, 'Every payout is checked', { size: 26, fill: INK3, weight: 600 })
        items.forEach(([h, sub, at], i) => {
          const yy = y + 150 + i * 150
          inner += fadeUp(
            t,
            at,
            check(x + 72, yy - 12, 26) +
              text(x + 124, yy, h, { size: 40, weight: 700, family: DISPLAY }) +
              text(x + 124, yy + 44, sub, { size: 24, fill: INK2 }),
          )
        })
        s += card(x, y, 780, 660, inner)
      }
      // right: the wallet
      {
        const x = 1000
        const y = 200
        const amount = 58 * ramp(t, 4.5, 1.4)
        const big = t < 4.5 ? '0 kr' : `${fmt(amount)} kr`
        let inner = text(x + 48, y + 72, 'Plånbok', { size: 26, fill: INK3, weight: 600 })
        inner += text(x + 48, y + 210, big, { size: 132, weight: 700, family: DISPLAY, fill: t >= 4.5 ? INK : INK3 })
        inner += group(
          chip(x + 48, y + 252, 'Kaffeklubben — hösten · Utbetald', { fill: '#dff3ea', color: GREEN, size: 22, weight: 700 }),
          { opacity: ramp(t, 5.7, 0.5) },
        )
        inner += fadeUp(
          t,
          6.1,
          text(x + 48, y + 400, '21 kr per post', { size: 34, family: MONO, fill: INK2 }) +
            text(x + 48, y + 452, '+ 43 kr per 1 000 verified views', { size: 34, family: MONO, fill: INK2 }) +
            rect(x + 48, y + 480, 660, 2, { fill: LINE }) +
            text(x + 48, y + 540, 'Paid out with Swish. Rates set per campaign.', { size: 24, fill: INK3 }),
        )
        s += card(x, y, 760, 660, inner)
      }
      return s
    },
  },
  {
    id: 's6-brand',
    dur: 16.2,
    draw(t) {
      let s = nav(t, 'FOR BRANDS')
      // dashboard card
      {
        const x = 120
        const y = 150
        const w = 980
        let inner = text(x + 48, y + 70, 'Kaffeklubben', { size: 22, fill: INK3, weight: 600 })
        inner += text(x + 48, y + 118, 'Kaffeklubben — hösten', { size: 42, weight: 700, family: DISPLAY })
        inner += chip(x + w - 48, y + 84, 'FILLING', { fill: AMBER_SOFT, color: AMBER_DK, size: 18, anchor: 'end', pad: 14 })
        // fill bar
        const spent = 0.42 * ramp(t, 0.5, 1.8)
        const reserved = 0.18 * ramp(t, 0.9, 1.8)
        inner += rect(x + 48, y + 160, w - 96, 18, { fill: LINE, r: 9 })
        inner += rect(x + 48, y + 160, (w - 96) * (spent + reserved), 18, { fill: AMBER_SOFT, r: 9 })
        inner += rect(x + 48, y + 160, (w - 96) * spent, 18, { fill: AMBER, r: 9 })
        inner += text(x + 48, y + 214, `${fmt(spent * 100)} % spent · ${fmt(reserved * 100)} % reserved · budget 50 000 kr`, {
          size: 22,
          fill: INK3,
        })
        // KPIs
        const kpis = [
          ['Placements', '214'],
          ['Verified views', '486 000'],
          ['Effective CPM', '41 kr'],
        ]
        kpis.forEach(([k, v], i) => {
          const kx = x + 48 + i * 300
          inner += fadeUp(
            t,
            1.5 + i * 0.2,
            text(kx, y + 280, k, { size: 20, fill: INK3, weight: 600 }) +
              text(kx, y + 330, v, { size: 44, family: MONO, weight: 600 }),
          )
        })
        // funnel
        const rows = [
          ['Claimed', 214],
          ['Participant review', 38],
          ['Live', 121],
          ['Verified', 97],
          ['Paid', 88],
        ]
        inner += text(x + 48, y + 410, 'Where the placements are', { size: 20, fill: INK3, weight: 600 })
        rows.forEach(([k, n], i) => {
          const ry = y + 440 + i * 62
          const p = ramp(t, 2.6 + i * 0.25, 0.8)
          const full = 560
          inner += text(x + 48, ry + 30, k, { size: 24, fill: INK2 })
          inner += rect(x + 300, ry + 10, full, 24, { fill: LINE, r: 12 })
          inner += rect(x + 300, ry + 10, full * (n / 214) * p, 24, { fill: i === 4 ? GREEN : i === 2 ? BLUE : AMBER, r: 12 })
          inner += text(x + w - 48, ry + 30, fmt(n * p), { size: 24, family: MONO, anchor: 'end' })
        })
        s += card(x, y, w, 790, inner, { opacity: ramp(t, 0.2, 0.6) })
      }
      // creative card
      {
        const x = 1160
        const y = 150
        const w = 640
        const h = 300
        const swap = ramp(t, 8.6, 0.9)
        let inner = text(x + 40, y + 60, 'Creative', { size: 22, fill: INK3, weight: 600 })
        // autumn
        inner += image(IMG.bagAutumn, x + 40, y + 90, 120, 160, { opacity: 1 - 0.55 * swap })
        inner += text(x + 40, y + 284, 'Kaffepåse 500g', { size: 22, weight: 700, fill: swap > 0.5 ? INK3 : INK })
        // arrow + winter
        inner += group(
          text(x + 214, y + 190, '→', { size: 64, fill: AMBER_DK, anchor: 'middle' }) +
            image(IMG.bagWinter, lerp(x + 320, x + 270, swap), y + 90, 120, 160) +
            text(x + 270, y + 284, 'Kaffepåse — vinter', { size: 22, weight: 700 }),
          { opacity: swap },
        )
        // in-flight count
        inner += chip(x + w - 40, y + 48, `3 in flight`, { fill: AMBER_SOFT, color: AMBER_DK, size: 18, anchor: 'end', pad: 14 })
        // button
        {
          const bo = win(t, 9.4, 11.2, 0.3)
          const sc = pulse(t, 10.3)
          inner += group(
            rect(x + 400, y + 200, 200, 60, { fill: INK, r: 30 }) +
              text(x + 500, y + 240, 'Replace', { size: 24, weight: 700, fill: WHITE, anchor: 'middle' }),
            { opacity: bo, transform: scaleAt(sc, x + 500, y + 230) },
          )
        }
        s += card(x, y, w, h, inner, { opacity: ramp(t, 0.6, 0.6) })
      }
      // thumbnails
      {
        const x = 1160
        const y = 490
        const tw_ = 200
        const th = 250
        const re = ramp(t, 11.0, 0.9, easeInOut)
        const thumbs = [
          [IMG.annaAutumn, IMG.annaWinter, '@anna_sthlm', true],
          [IMG.shelfAutumn, null, '@lina_food', false],
          [IMG.sillAutumn, IMG.sillWinter, '@jonas_gym', true],
        ]
        let inner = ''
        thumbs.forEach(([a, b, handle, swaps], i) => {
          const tx = x + i * (tw_ + 20)
          const p = ramp(t, 1.2 + i * 0.2, 0.6)
          let th_ = image(a, tx, y, tw_, th, { r: 20 })
          if (swaps && b) th_ += image(b, tx, y, tw_, th, { r: 20, opacity: re })
          if (swaps && re > 0 && re < 1) th_ += rect(tx, y, tw_, th, { fill: AMBER, r: 20, opacity: 0.35 * Math.sin(re * Math.PI) })
          th_ += text(tx, y + th + 34, handle, { size: 20, weight: 600, fill: INK2 })
          if (!swaps) th_ += chip(tx + tw_ / 2, y + th - 50, 'Approved · locked', { fill: INK, color: WHITE, size: 16, anchor: 'middle', pad: 12, opacity: ramp(t, 11.2, 0.5) })
          else th_ += chip(tx + tw_ / 2, y + th - 50, 'Re-rendered', { fill: GREEN, color: WHITE, size: 16, anchor: 'middle', pad: 12, opacity: ramp(t, 11.9, 0.5) })
          inner += group(th_, { opacity: p })
        })
        inner += fadeUp(
          t,
          12.4,
          text(x, y + th + 110, '2 placements re-rendered · 0.4 s', { size: 30, weight: 700, family: DISPLAY, fill: AMBER_DK }) +
            text(x, y + th + 150, 'Approved images never change — the participant said yes to that picture.', {
              size: 21,
              fill: INK2,
            }),
        )
        s += inner
      }
      return s
    },
  },
  {
    id: 's7-trust',
    dur: 12.2,
    draw(t) {
      let s = nav(t, 'TRUST')
      const cards = [
        ['BankID-verified people', 'One real person per account. The personal number is never stored.', 0.4, 'id'],
        ['Always disclosed', 'Disclosure is a payable condition, not an option.', 3.0, 'tag'],
        ['Paid only on verified views', 'Views, disclosure and media match — checked before every payout.', 5.6, 'eye'],
        ['NOD never posts for you', 'No write access to any social account. You publish.', 8.3, 'no'],
      ]
      cards.forEach(([h, sub, at, icon], i) => {
        const x = 200 + (i % 2) * 780
        const y = 190 + Math.floor(i / 2) * 370
        const w = 740
        const hh = 320
        let ic = ''
        const ix = x + 48
        const iy = y + 48
        if (icon === 'id') ic = rect(ix, iy, 56, 68, { fill: '#193e6a', r: 12 }) + text(ix + 28, iy + 46, 'ID', { size: 28, weight: 700, family: DISPLAY, fill: WHITE, anchor: 'middle' })
        if (icon === 'tag') ic = chip(ix, iy + 8, 'Reklam', { fill: AMBER_SOFT, color: AMBER_DK, size: 24, pad: 16 })
        if (icon === 'eye') ic = `<ellipse cx="${ix + 34}" cy="${iy + 34}" rx="34" ry="22" fill="none" stroke="${INK}" stroke-width="5"/>` + circle(ix + 34, iy + 34, 11, { fill: INK }) + check(ix + 66, iy + 56, 14)
        if (icon === 'no') ic = circle(ix + 34, iy + 34, 30, { fill: 'none', stroke: RED, sw: 6 }) + `<line x1="${ix + 13}" y1="${iy + 13}" x2="${ix + 55}" y2="${iy + 55}" stroke="${RED}" stroke-width="6" stroke-linecap="round"/>` + text(ix + 34, iy + 44, '✎', { size: 28, anchor: 'middle', fill: INK })
        s += fadeUp(
          t,
          at,
          card(
            x,
            y,
            w,
            hh,
            ic +
              text(x + 48, y + 190, h, { size: 40, weight: 700, family: DISPLAY }) +
              text(x + 48, y + 240, sub.length > 62 ? sub.slice(0, sub.lastIndexOf(' ', 62)) : sub, { size: 24, fill: INK2 }) +
              (sub.length > 62 ? text(x + 48, y + 276, sub.slice(sub.lastIndexOf(' ', 62) + 1), { size: 24, fill: INK2 }) : ''),
          ),
        )
      })
      return s
    },
  },
  {
    id: 's8-cta',
    dur: 6.4,
    draw(t) {
      const p = ramp(t, 0.1, 0.8)
      return (
        group(wordmark(W / 2, 520, 220, { anchor: 'middle' }), { opacity: p, transform: scaleAt(lerp(0.95, 1, p), W / 2, 460) }) +
        circle(W / 2 + 236, 512, 16, { fill: AMBER, opacity: ramp(t, 0.6, 0.4) }) +
        fadeUp(t, 0.9, text(W / 2, 620, 'Post as usual. Get paid.', { size: 56, anchor: 'middle', fill: INK2 })) +
        fadeUp(t, 2.0, text(W / 2, 740, 'nod.se', { size: 48, anchor: 'middle', family: MONO, fill: AMBER_DK, weight: 600 })) +
        fadeUp(t, 2.7, text(W / 2, 800, 'For brands: nod.se/brands', { size: 30, anchor: 'middle', fill: INK3 }))
      )
    },
  },
]

// ---------- timeline ----------

let cursor = 0
for (const sc of scenes) {
  sc.start = cursor
  cursor += sc.dur
}
const TOTAL = cursor

function frameSvg(T) {
  uid = 0
  const sc = scenes.find((s) => T >= s.start && T < s.start + s.dur) ?? scenes[scenes.length - 1]
  const t = T - sc.start
  const body = sc.draw(t)
  const veil = 1 - win(t, 0, sc.dur, 0.4)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${BG}"/>
${body}
${rect(0, 0, W, H, { fill: BG, opacity: veil })}
</svg>`
}

async function rasterise(T, format) {
  const svg = Buffer.from(frameSvg(T))
  const img = sharp(svg, { density: 72 * SCALE })
  return format === 'png' ? img.png().toBuffer() : img.removeAlpha().raw().toBuffer()
}

// ---------- single frame ----------

if (args.includes('--frame')) {
  const T = Number(opt('--frame', '0'))
  const out = opt('--png', path.join(BUILD, `frame-${T}.png`))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, await rasterise(T, 'png'))
  console.log(`wrote ${out} (t=${T}s of ${TOTAL.toFixed(1)}s)`)
  process.exit(0)
}

// ---------- video ----------

fs.mkdirSync(BUILD, { recursive: true })
fs.mkdirSync(path.dirname(OUT), { recursive: true })
const videoOnly = path.join(BUILD, 'video.mp4')
const frames = Math.round(TOTAL * FPS)
const size = `${W * SCALE}x${H * SCALE}`

console.log(`rendering ${frames} frames at ${size} ${FPS} fps (${TOTAL.toFixed(1)} s)`)
const ff = spawn(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', size, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', QUICK ? 'veryfast' : 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoOnly],
  { stdio: ['pipe', 'inherit', 'inherit'] },
)

const started = Date.now()
const BATCH = 6
for (let i = 0; i < frames; i += BATCH) {
  const batch = []
  for (let j = i; j < Math.min(frames, i + BATCH); j++) batch.push(rasterise(j / FPS, 'raw'))
  for (const buf of await Promise.all(batch)) {
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain')
  }
  if (i % (FPS * 5) === 0) {
    const pct = Math.round((i / frames) * 100)
    process.stdout.write(`\r  ${pct}%  (${((Date.now() - started) / 1000).toFixed(0)} s)`)
  }
}
ff.stdin.end()
await once(ff, 'close')
process.stdout.write('\r  100%\n')

// ---------- audio ----------

const inputs = ['-i', videoOnly]
const filters = []
const mixIn = []
let n = 1
for (const sc of scenes) {
  const wav = path.join(VO_DIR, `${sc.id}.wav`)
  if (!fs.existsSync(wav)) continue
  inputs.push('-i', wav)
  const ms = Math.round((sc.start + VO_LEAD) * 1000)
  filters.push(`[${n}]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms},volume=1.0[v${n}]`)
  mixIn.push(`[v${n}]`)
  n++
}
if (mixIn.length === 0) console.warn('no narration WAVs found — run tts.ps1 for the voice; producing a music-only track')

// A slow A-major pad: four sines, a breathing LFO, lowpassed, well under the voice.
const pad =
  `aevalsrc='(0.16*sin(2*PI*110*t)+0.12*sin(2*PI*164.81*t)+0.09*sin(2*PI*220*t)+0.07*sin(2*PI*277.18*t))*(0.75+0.25*sin(2*PI*0.08*t))':s=48000:c=stereo:d=${TOTAL.toFixed(2)},` +
  `lowpass=f=420,tremolo=f=0.35:d=0.25,volume=0.32,afade=t=in:d=1.5,afade=t=out:st=${(TOTAL - 3).toFixed(2)}:d=3[pad]`
filters.push(pad)
// The pad is exactly TOTAL long, so it goes first and sets the mix length.
mixIn.unshift('[pad]')
filters.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=first[mix]`)
filters.push(`[mix]alimiter=limit=0.95[a]`)

execFileSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', OUT],
  { stdio: 'inherit' },
)

const bytes = fs.statSync(OUT).size
console.log(`wrote ${OUT}  ${(bytes / 1e6).toFixed(1)} MB  ${TOTAL.toFixed(1)} s  in ${((Date.now() - started) / 1000).toFixed(0)} s`)
