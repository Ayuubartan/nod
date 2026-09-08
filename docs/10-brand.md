# 10 — Brand

## Name

**Boogaa.** Wordmark set as **BOOGAA** (heavy caps, tight tracking) in the logo lockup;
"Boogaa" in running text. It is a verb as much as a name: a brand *Boogaas* you when it
pays to sit in something you were posting anyway. "I got Boogaa'd."

`NOD` remains the internal codename — repo, docs, env vars, cookies (see CLAUDE.md).
Domain: **joinbooga.se**. Public strings come from `lib/brand.ts` (`BRAND`, `WORDMARK`,
`BRAND_DOMAIN`, `HELLO_EMAIL`) and the i18n files; never hardcode either name.

Tagline (en): *Get paid for the content you already post.*
Tagline (sv): *Få betalt för innehållet du redan postar.*

"Simple. Bold. Memorable."

## The mark

A teal circle with a bite taken out of its right side and an orange bolt inside.
`components/Logo.tsx` draws it inline: `BoogaaMark` is the symbol alone, `Logo` the
primary lockup (mark + wordmark). The wordmark is `currentColor`, so the dark lockup —
teal mark, paper wordmark on ink — costs nothing. `app/icon.tsx`, `app/apple-icon.tsx`
and `app/opengraph-image.tsx` render the same paths.

Never recolour the mark. Never put the bite on the left.

## Colours

```css
:root {
  --color-teal:    #20C5C7;  /* BOOGAA TEAL — the mark, highlights, "join" */
  --color-orange:  #FF7417;  /* BOOGAA ORANGE — the primary action, "waiting on you" */
  --color-ink:     #111820;  /* INK BLACK — text */
  --color-bg:      #F4F1EA;  /* PAPER — background */

  --color-surface: #FFFFFF;
  --color-ink-2:   #4B5560;
  --color-ink-3:   #8A929B;
  --color-line:    #E1DDD3;
  --color-green:   #1F9D6B;  /* paid, verified */
  --color-red:     #D6453D;  /* rejected, expired */
  --color-blue:    #2F6FE4;  /* brand side accent */
}
/* dark mode: paper ↔ ink, teal and orange unchanged */
```

Rules of thumb: teal is the brand and lives in the mark, chips, focus rings, the
placement marker and the nav pill. Orange is the *one* action on a page and the colour
of money waiting on you. Ink on paper for everything else. Do not put teal text on
paper — it fails contrast; use `--color-teal-dk` or set it as a block behind ink text.

## Typography

- **Space Grotesk** — headings, buttons, chips, the wordmark. Headlines are set with
  `.display`: 700, uppercase, `letter-spacing: -0.03em`, `line-height: 0.95`.
- **Inter** — body and UI.
- **Permanent Marker** — handwritten accents only (`.marker`): a note on a photo, a
  one-line aside. Never for body, never for anything a person must read to use the
  product.
- **JetBrains Mono** — amounts and IDs, always tabular figures (`.amount`, `.tabular`).

Loaded with `next/font` in `app/layout.tsx`; the CSS variables are `--font-display`,
`--font-sans`, `--font-marker`, `--font-mono`.

## Elements

"Stickers. Posters. Social. Real life." The site borrows the poster language sparingly:

- `.brush` — the word BOOGAA in a hero line: teal block, slight tilt, orange underline.
- `.tape`, `.tape-teal`, `.tape-grey` — tape strips over the corner of a photo or card.
- `.torn` — torn-paper bottom edge on a photo.
- `.rule-teal` — teal rule under a sentence (the footer bar).
- `.nod-marker` — the placement marker: teal dot with a soft ring, on the landing page
  and as the pin in the app.

One or two per screen. The app screens (participant, brand, ops) use none of them —
they get the colours and the type only.

## Taglines

Headline lines are uppercase in `.display`; in i18n they are sentence case and the CSS
does the shouting.

- WHO CAN BOOGAA ME? — hero (BOOGAA in `.brush`)
- PEOPLE POST. BRANDS PAY. EVERYONE WINS.
- SAME INTERNET. BETTER PEOPLE.
- GOOD PEOPLE GO FURTHER.
- YOU POST. BRANDS BOOGAA. YOU GET PAID. — footer bar
- I GOT BOOGAA'D. / WHO BOOGAA'D STOCKHOLM? / STOCKHOLM IS GETTING BOOGAA'D. — campaign

Swedish carries the same lines (`Vem kan Boogaa mig?`, `Folk postar. Varumärken
betalar. Alla vinner.`, `Du postar. Varumärken Boogaar. Du får betalt.`).

## Buttons and chips

- `.btn-primary` — orange pill, white text: "Join BOOGAA →". One per view.
- `.btn-secondary` — outlined ink pill: "Learn more".
- `.btn-teal` — teal pill, ink text: the nav "Join BOOGAA".
- `.btn-ink` — ink pill, paper text: "Get started →".
- `.chip-ink` — outlined ink chips: Creators · Brands · Community · Stockholm · Real reach.
- `.chip[aria-pressed=true]` — teal.

## Landing page

Nav: Home · Features · Community · For brands · [Join BOOGAA]. Hero with the phone
mock taped to the page and a handwritten note. A stats row under the CTAs
("4 821 people waiting · 127 creators posting · 2.4M collective reach") — **live
counts from `lib/landing-stats.ts`, never placeholders; a zero is hidden, not faked.**
Three steps with icons: Pick a campaign (play) · Post like normal (phone) · Get paid
(wallet). Footer bar: YOU POST. BRANDS BOOGAA. YOU GET PAID. on paper with a teal rule.

## Voice

- Plain. Short sentences. No ad-industry words on the participant side ("inventory",
  "CPM", "activation" live on `/brands` and in the dashboard).
- Honest about money: show the number, show when it's paid, show what's pending.
- Never hype, never fake. No invented queue numbers, no "only 3 spots left".
- Swedish first in tone even in English: direct, a little dry, friendly. The posters
  shout; the product talks normally.

Examples
- ✔ "You'll get about 40 kr for this one. Paid via Swish within 48 hours after we verify the views."
- ✘ "Unlock exciting earning opportunities with top brands!"

## Earnings card

The shareable one (`app/api/og/earnings`): white card on paper, orange amount in
Space Grotesk 800, "via Boogaa" small, the participant's chosen emoji, no brand logo
unless the brand opts in. Must look good as an Instagram Story at 1080×1920.

## Brand side

Same tokens, `--color-blue` as the accent instead of orange, denser layout, numbers
first. Dashboard shows spent / reserved / available as three equal cards at the top of
every campaign — that trio is the brand-side signature.

## Email and SMS

Email: paper background, wordmark with a teal dot, orange button with white text
(`lib/email.ts` `shell`/`button`). SMS signs off "– Boogaa" (`lib/waitlist-sms.ts`).
