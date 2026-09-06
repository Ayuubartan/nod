# 01 — Landing Page

**Goal:** 300+ qualified waitlist signups in Stockholm before any product exists. Secondary: brand enquiries.

Route group: `app/(marketing)/`. Routes: `/` (participant-first), `/brands`, `/waitlist` (deep link to form), `/privacy`, `/terms`. Language toggle sv/en, default from `Accept-Language`, persisted in cookie.

## Page structure — `/`

### 1. Hero
- Eyebrow: `NOD · Stockholm beta`
- H1 (sv): **Posta som vanligt. Tjäna på uppmärksamheten du redan har.**
- H1 (en): **Post like you normally do. Earn from the attention you already have.**
- Sub (sv): Brands betalar för att synas naturligt i dina bilder och stories. Du väljer brand, du väljer var, du godkänner allt. Sen postar du som vanligt och får betalt per visning.
- Sub (en): Brands pay to appear naturally in your photos and Stories. You pick the brand, you pick where, you approve everything. Then you post as usual and get paid per view.
- CTA primary: `Ställ dig i kön` / `Join the waitlist` → scrolls to form
- CTA secondary: `Är du ett brand?` / `Are you a brand?` → `/brands`
- Visual: a phone mock showing a normal café photo, a small amber "nod" marker on the cup, and a wallet card "+42 kr". No stock photos of influencers.

### 2. How it works (3 steps)
| # | sv | en |
|---|---|---|
| 1 | **Välj en kampanj.** Bläddra bland brands som betalar just nu. Ta bara de du gillar. | **Pick a campaign.** Browse brands paying right now. Only take the ones you like. |
| 2 | **Placera brandet.** Ladda upp bilden du ändå skulle posta. Välj var produkten ska synas. Godkänn resultatet. | **Place the brand.** Upload the photo you were going to post anyway. Choose where the product appears. Approve the result. |
| 3 | **Posta och få betalt.** Posta till ditt eget konto med tydlig reklammärkning. Vi verifierar visningarna och betalar via Swish. | **Post and get paid.** Post to your own account with clear ad disclosure. We verify the views and pay via Swish. |

### 3. Earnings estimator (interactive)
Inputs: platform (Instagram / TikTok), followers (slider 100–20,000), average Story/Reel views (slider 50–10,000, prefilled at ~55% of followers).
Output: **"Ungefär X–Y kr per kampanj"** / **"Roughly X–Y kr per campaign"**, using `docs/05-pricing.md` participant rates: `fixed + (views/1000 × cpm)` at low and high template rates. Show a one-line note: *Faktisk ersättning sätts per kampanj.* / *Actual payout is set per campaign.*
Below: three example rows — 400 views → ~38 kr · 1,500 views → ~88 kr · 5,000 views → ~245 kr (recompute from pricing doc at build time; do not hardcode).

### 4. Trust block (3 cards)
- **Du godkänner allt** / **You approve everything** — Nothing is posted without you seeing it. Regenerate, move, or reject — free.
- **Alltid märkt som reklam** / **Always disclosed as an ad** — Every post carries clear disclosure. That's the law, and it's how we keep it real.
- **Verifierat med BankID** / **Verified with BankID** — One person, one account. Brands know every participant is real. No bots, no fakes.

### 5. Who it's for
Short line: *Du behöver inte vara influencer. 300 följare räcker.* / *You don't need to be an influencer. 300 followers is enough.* Then a row of category chips: Gym · Mat · Plugg · Resor · Outfit · Gaming · Utekväll · Hobby.

### 6. FAQ (accordion)
- Måste jag ha många följare? / Do I need many followers? — No. From ~300 followers or ~100 average views.
- Vad händer med min bild? / What happens to my photo? — You upload it, choose where the brand goes, and see the result before anything is published. You post it yourself. NOD never posts for you.
- Hur får jag betalt? / How do I get paid? — Swish, within 48 hours of verification. Minimum payout 100 kr.
- Är det lagligt? / Is this legal? — Yes. Every post is clearly marked as advertising, as required by Swedish marketing law. Undisclosed posts aren't paid.
- Varför BankID? / Why BankID? — To make sure every participant is a real person over 18, and so you can be paid via Swish.
- Kan jag använda flera konton? / Can I use several accounts? — Yes, as long as they're yours. Each qualifies on its own.
- Vad kostar det? / What does it cost? — Nothing. Ever.

### 7. Waitlist form (`#waitlist`)
Fields (all required unless noted):
- Instagram or TikTok handle (text; auto-detect platform from `@` or URL)
- City (select: Stockholm, Göteborg, Malmö, Uppsala, Other)
- Age bracket (select: 18–20, 21–25, 26–30, 31+) — **under 18 not offered**
- Followers (select: <300, 300–1k, 1k–5k, 5k–20k, 20k+)
- Main content (multi-select chips: gym, food, study, travel, fashion, gaming, nightlife, hobby, other)
- Email
- Consent checkbox: *Jag godkänner att NOD sparar mina uppgifter för att kontakta mig om betan.* / *I agree NOD stores my details to contact me about the beta.* Link to `/privacy`.
- Optional: referral code (prefilled from `?ref=`)

On submit: insert `WaitlistEntry`, send confirmation email (Resend) with position number and a personal referral link (`nod.se/?ref=CODE` — domain placeholder), show success state with share buttons (copy link, Instagram Story share image).

### 8. Footer
NOD · Stockholm · hello@ (placeholder) · Privacy · Terms · Language toggle · "Är du ett brand?"

## `/brands` page

- H1 (en): **Reach thousands of real social circles through one campaign.**
- H1 (sv): **Nå tusentals verkliga sociala nätverk med en kampanj.**
- Sub: NOD places your product naturally in the everyday posts of real, BankID-verified people in your target market. Disclosed, contextual, verified per view. One dashboard. One effective CPM.
- Three stats blocks (labelled illustrative until real): participants in Stockholm beta · verified placements · effective CPM range
- "How it works for brands" — 4 steps: set budget + audience + assets → we match eligible participants → they place and post → you see qualified views and pay only for those
- Pricing block: *From 60 kr per 1,000 qualified views, plus optional fixed per placement. You set the numbers above our floors. Prepaid; unspent budget refunded.*
- Enquiry form: company, name, email, budget bracket (10–25k / 25–100k / 100k+ SEK), objective, message → `BrandEnquiry` table + email to ops.

## Tech notes

- Static/ISR. No auth. Lighthouse ≥ 95 on mobile.
- Estimator is a client component reading rates from `lib/money/rates.ts` (same file the product uses — one source of truth).
- PostHog events: `waitlist_viewed`, `estimator_used` (with bucketed inputs), `waitlist_submitted`, `referral_link_copied`, `brand_enquiry_submitted`.
- OG image generated per referral link ("Anna invited you to NOD").
- Design per `docs/10-brand.md`. Mobile first; 80%+ of traffic will be from Instagram/TikTok in-app browsers, so no heavy animations, no video autoplay.

## Acceptance

- Both languages complete, no missing keys
- Form validates, stores, emails, shows referral link
- Estimator numbers match `lib/money/rates.ts`
- Under-18 cannot be selected
- Privacy + terms pages exist with real (draft) text from `docs/07-compliance.md`
