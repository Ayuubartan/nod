# 00 — Brief

## One sentence

**NOD turns the social reach of ordinary people into advertising inventory that brands can buy at scale.**

## The name

A *nod* is a small, natural acknowledgement — a brand appearing in someone's photo the way it would in real life, not a commercial. Short, works in Swedish and English, one syllable, easy to say in a payout screenshot ("got paid by NOD").

## What it is

A two-sided marketplace.

- **Participants** — everyday Instagram/TikTok users, not influencers. They browse funded campaigns, pick a brand they like, upload content they were already going to post, choose where the brand should naturally appear, approve the result, publish it disclosed to their own account, and get paid on verified views.
- **Brands** — fund a campaign with a budget, audience filters, assets and placement rules. They see one dashboard: participants, placements, qualified views, effective CPM. They never negotiate with individuals.
- **NOD** — runs the market: eligibility, placement generation, approval, verification, fraud, payments, reporting. Keeps a spread between what the brand pays per view and what the participant receives.

## What it is not

- Not an influencer marketplace (supply is everyone, not the top 0.1%)
- Not an AI creator tool (the placement engine is infrastructure, not the story)
- Not hidden advertising (disclosure is a payable condition)

## The insight

One person with 800 followers gets 450 Story views — irrelevant to Nike. 50,000 of them are 25 million impressions. The audience exists; what's missing is the machine that organises, buys, verifies and pays for it at near-zero transaction cost.

## How NOD makes money

Brand pays a CPM (and optionally a fixed per-placement fee). Participant receives a lower CPM. The spread — target ~28% — is NOD's revenue, recognised per placement as it qualifies. Brands prepay; NOD holds the deposit; unspent budget is refunded at close.

## Pilot

Stockholm · 18–25 · one or two anchor brands · 200–300 participants · one campaign end to end with real money. Success = both hypotheses answered and a verified effective CPM a brand accepts.

## Principles that govern every product decision

1. **The participant approves everything.** Nothing publishes without their sign-off. Their feed, their call.
2. **Brands approve rules, not people.** Filters at campaign creation; NOD auto-qualifies. Brands review placements (tiered), never account lists.
3. **Only qualified views are billable or payable.** Verification decides what counts.
4. **Every timed state expires.** Budget never sits locked in an abandoned claim.
5. **Ship the spreadsheet version first.** Anything marked "ops" in the workflow can be a person for the first three campaigns.

## Relationship to Parallel

NOD is the marketplace. Parallel is the placement engine. Every NOD transaction produces labelled placement data (surface chosen, regenerations, approval, views, brand acceptance) that trains Parallel. One company, one story. In code, the engine is an interface (`lib/integrations/engine.ts`) with a manual/ops implementation first and Parallel's API later.
