# Work log

Running notes on what changed after the milestone plan in `docs/09` was completed, why, and
what it unlocked. Newest entry first. Each entry names the commit it describes.

---

## 2026-09-07 — Direct placement, creative as a distribution layer, brand dashboard

**Ask:** make the AI placement happen directly for everyone (no waiting on the ops queue),
make NOD work as a distribution layer where the brand can change the creative on a live
campaign, and make the brand dashboard actually useful.

### 1. Direct placement — `LocalCompositeEngine`

The pilot had a gap: docs/06 §6 lists three engines (ops queue, hosted inpaint, in-house),
and with no inpainting key configured *every* placement waited for a human. That made the
product a service, not a marketplace.

`lib/integrations/composite.ts` closes the gap with an in-process compositor (sharp): it
scales the product to the surface the participant chose, sits it on the bottom edge of that
surface, matches its brightness to the scene under it, and drops a soft shadow. ~200 ms,
no third party, no cost per render. Nothing outside the chosen region is touched, which is
also what the media-match verification check relies on.

The engine chain is now, top to bottom:

```
hosted inpaint (if INPAINT_PROVIDER + INPAINT_API_KEY)
  -> local composite (always available)
    -> ops queue (a human; never fails)
```

Each layer is wrapped in `FallbackEngine`, so an outage degrades one step instead of
stranding the participant in GENERATING. `NOD_ENGINE=hosted|local|ops|fake` forces one
layer; the DB flag `engine.autoRender` (default on) is the ops kill switch — off means
every render waits for a human, exactly as in the pilot, without a deploy.

`lib/render.ts` is the one place P-04 happens. Before it, the position step and the
regenerate step each did half of the work differently, and a regeneration never actually
asked the engine for anything. Now: position → `generate()` → PARTICIPANT_REVIEW on the
same request. Regenerate, brand swap, the Inngest retry job and the ops "Run engine"
button all call the same function.

The position step itself (`components/participant/PositionStep.tsx`) now shows the
participant's real photo with the product previewed inside a draggable region, so they
see where the product will land before they confirm — instead of picking from three
labelled rectangles on a grey box.

### 2. Creative as a distribution layer — `lib/creative.ts`

A brand uploads a product once and NOD distributes it into many people's posts. The
consequence: the creative is not frozen at launch. `replaceCreative()` retires an asset,
points every *swappable* placement at the replacement, and re-renders them. Swappable
means nobody has approved an image yet: `POSITIONED`, `GENERATING`, `GENERATION_FAILED`,
`PARTICIPANT_REVIEW`. From `BRAND_REVIEW` onward the image is locked — the participant
said yes to *that* picture and will publish it to their own account.

Design decisions:

- The participant's region is kept (it is their training label).
- The swap does not consume any of the participant's three regenerations —
  `regenerate()` grew `kind: 'REGEN' | 'MOVE' | 'SWAP'` and `countsTowardLimit` for this.
- The retire is audited (`CampaignAsset RETIRE`, with the affected placement ids) and the
  swap lands on the training stream as a `SWAP` PlacementEvent, so the export can tell
  brand-driven changes from participant taste.
- The last asset on a campaign cannot be retired.

The brand sees it on the campaign's **Creative** tab: per asset, a thumbnail, how many
placements are still in flight on it, "Replace with… → Replace and re-render", and Retire
(disabled while anything is in flight).

### 3. Brand dashboard

Rebuilt around what a brand actually asks: *how full is it, where are people stuck, is
anything waiting on me.*

- **Campaign index** — summary strip (active campaigns, total budget, placements,
  qualified views), then one card per campaign with a fill bar (spent solid, reserved
  hatched), a "next step" hint keyed on the campaign state, and a review-queue badge.
- **Campaign overview** — shared `CampaignHeader` (back link, state chip, next step, dates,
  fund button when awaiting funds) and `CampaignTabs` (Overview · Creative · Review ·
  Report · Edit). Then: budget trio + fill bar, KPIs, a nine-stage placement **funnel**
  (claimed → making → participant review → brand review → approved → published →
  verified → paid → ended; the brand-review stage links to the queue), a creative strip
  with in-flight counts, the daily views chart, and a placement table with the rendered
  thumbnail, handle, city, content type, views, qualified views, disclosure and post link.
- All new copy is in `brandApp.*` in `en.json` / `sv.json`.

### 4. Seed and dev ergonomics

- The seed generates real artwork (`lib/demo-art.ts`: coffee bag in autumn and winter
  palettes, a logo, a kitchen scene and a desk scene — shapes only, so it renders the
  same on every machine) and writes it to `.storage/` at the paths the media proxy
  serves. It then drives four placements on the live campaign through the real state
  machine: one in participant review, one in brand review, one published, one paid.
- `pnpm db:seed` runs with `--conditions=react-server` so the `server-only` guard on
  `lib/render` and `lib/storage` is a no-op outside Next.
- `emit()` returns immediately when there is no `INNGEST_EVENT_KEY` (and no
  `INNGEST_DEV=1`). Before this every emit was a 2 s 401 against the cloud API; the seed
  took 79 s, now 3 s, and every server action in dev was paying the same tax.
- `NOD_FAKE_PROVIDERS` no longer forces the fake engine — the compositor has no third
  party behind it, so dev gets real renders. Tests set `NOD_ENGINE=fake` themselves.
- `lib/flags.ts`: flag values are widened from their literal defaults (a flag whose
  default is `false` can be set to `true` without a cast).

### Tests

- `tests/composite.test.ts` — output keeps the canvas size, the product lands inside the
  region, pixels far from the region are unchanged within JPEG noise, bad input throws.
- `tests/creative.db.test.ts` — position renders straight to PARTICIPANT_REVIEW with a
  version; `engine.autoRender=false` defers and "run engine" later renders; missing asset
  fails cleanly; swap re-renders in-flight placements, leaves BRAND_REVIEW alone, does not
  touch `regenCount`, retires softly, audits, and refuses same-asset / cross-campaign.

`pnpm typecheck && pnpm lint && pnpm test` — 279 tests green.

### Follow-ups found in the browser walkthrough

- A brand session landing on a participant route (`/placements`) redirected to
  `/campaigns`, which is also a participant route: an infinite 307 loop. `requireRole`
  now sends brand sessions to `/brand/campaigns`.
- Retired assets leaked into two places that read `campaign.assets` without a
  `deletedAt` filter: the participant's campaign page (the product chips) and the
  campaign submit guard (a campaign whose only asset was retired could still be
  submitted). Both now filter. The ops generation queue deliberately keeps all assets —
  a placement that got stuck may reference one that has since been retired.
- `StateChip` gained a `perspective` prop. The brand's placement table showed
  "Väntar på dig" on PARTICIPANT_REVIEW, which is the participant's wording. From the
  brand side the participant's steps are neutral "in progress" (`Deltagaren granskar`)
  and BRAND_REVIEW is the amber "waiting on you". Keys live under
  `placement.brandStates` (sv/en) and only cover the states whose wording depends on
  who is reading.

### Walkthrough (what the screenshots show)

1. `/dev` → sign in as Anna (`seed-p1`) → open the placement in participant review — the
   composite the seed rendered, with before/after and the regenerate controls.
2. As Jonas: claim on the live campaign → upload `.storage/demo/kitchen.jpg` → the
   position step shows the photo with the (winter) bag previewed inside a draggable region
   and three dashed suggestions → tap the counter suggestion → Fortsätt → the composite
   (brightness-matched, soft shadow, sitting on the plate) is in review on the same
   request, with the before/after slider and "Generera om · 3 kvar".
3. `/dev` → brand user → `/brand/campaigns` (index) → the live campaign (overview with
   funnel and fill) → **Creative** tab → replace "Kaffepåse 500g" with "Kaffepåse — vinter"
   → in-flight placements re-render in the winter palette.
4. `/dev` → ops → generation queue — empty unless `engine.autoRender` is off.

### 5. Intro video — `scripts/intro-video/`

An explainer/ad for NOD, rendered from code so it stays in sync with the product's
palette and copy: `docs/media/nod-intro.mp4`, 1920×1080, 30 fps, 78.6 s, narrated.

- `render.mjs` describes eight scenes as functions of time that return SVG (logo →
  problem → idea → participant flow → getting paid → brand dashboard with a creative
  swap → trust rules → call to action). sharp rasterises each frame, ffmpeg encodes
  them from stdin, then a second pass mixes the narration and a synthesised pad.
- The flow and brand scenes use real renders from the seed: Anna's kitchen photo with
  the autumn and winter bags, and the shelf/sill composites from the creative swap, so
  the "re-render" moment in the video is the actual output of `LocalCompositeEngine`.
- `narration.json` + `tts.ps1` produce the voice with the Windows speech synthesizer
  (Zira). It is a placeholder read; drop recorded WAVs with the same ids into
  `.build/vo/` and re-run `pnpm video`. Missing WAVs fall back to music only.
- `--frame <t> --png <file>` dumps a single frame, which is how the layout was checked
  (contact sheets of eight frames per half).

### Still open

- The compositor is a compositor: it does not relight, occlude or match perspective. The
  hosted inpaint engine (M5 task 1) sits above it for that and activates on credentials.
- Swaps re-render synchronously in the brand's request. Fine at pilot scale (tens of
  placements); at hundreds it should fan out to an Inngest job per placement.
- Retired assets stay visible as "retired" in the manager; there is no un-retire yet.
- The video's narration is synthetic. A human read (Swedish, ideally) is the obvious
  upgrade; the timeline gives each scene ~1 s of slack after its line.
