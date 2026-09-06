# 10 — Brand

## Name

**NOD.** Always uppercase in logotype, "NOD" in running text. A nod is a small, natural acknowledgement — the way a product appears in a real photo, not a commercial. One syllable in Swedish and English.

Tagline (sv): *Posta som vanligt.*
Tagline (en): *Post like you normally do.*

## Voice

- Plain. Short sentences. No ad-industry words on the participant side (no "inventory", "CPM", "activation" — those live on `/brands` and in the dashboard).
- Honest about money: show the number, show when it's paid, show what's pending.
- Never hype. No "unlock your potential", no "creator journey". The product is: post, earn, done.
- Swedish first in copy tone even in English: direct, a little dry, friendly.

Examples
- ✔ "You'll get about 40 kr for this one. Paid via Swish within 48 hours after we verify the views."
- ✘ "Unlock exciting earning opportunities with top brands!"

## Visual tokens

Distinct from Parallel (which is dark, orange/cyan, technical). NOD is lighter and warmer — it lives in an Instagram in-app browser next to people's own photos, so it shouldn't look like a fintech dashboard.

```css
:root {
  /* surfaces */
  --nod-bg:        #FAF7F2;   /* warm off-white */
  --nod-surface:   #FFFFFF;
  --nod-ink:       #14110F;   /* near-black text */
  --nod-ink-2:     #5C554D;
  --nod-ink-3:     #A39B91;
  --nod-line:      #E8E2DA;

  /* accent */
  --nod-amber:     #F5A524;   /* the "nod" marker, CTAs, earnings */
  --nod-amber-dk:  #C77E0A;
  --nod-green:     #1F9D6B;   /* paid, verified */
  --nod-red:       #D6453D;   /* rejected, expired */
  --nod-blue:      #2F6FE4;   /* brand side accent */
}
/* dark mode: invert surfaces, keep amber */
```

Type: **Outfit** for headings (700/800), **Plus Jakarta Sans** for body, **JetBrains Mono** for amounts and IDs. Amounts always tabular figures.

Shapes: 12px radius cards, 1px lines, no shadows heavier than `0 1px 2px rgba(0,0,0,.06)`. The amber "nod" marker is a small filled circle with a soft ring — used on the landing page to show where a placement sits, and in the app as the placement pin.

Earnings card (the shareable one): white card, amber amount in Outfit 800, "via NOD" small, participant's chosen emoji, no brand logo unless the brand opts in. Must look good as an Instagram Story at 1080×1920.

## Brand side

Same tokens, `--nod-blue` as the accent instead of amber, denser layout, numbers first. Dashboard shows spent / reserved / available as three equal cards at the top of every campaign — that trio is the brand-side signature.

## Domain / handles

Placeholders in code: `nod.se`, `@nod.se`, `hello@nod.se`. Check availability; fall back to `getnod.se` / `nodapp.se`. Do not hardcode the domain — use `NEXT_PUBLIC_SITE_URL`.
