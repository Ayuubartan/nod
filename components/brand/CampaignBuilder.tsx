'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  saveAudience,
  saveBasics,
  saveBudget,
  savePayoutTemplate,
  saveRules,
  submitCampaign,
} from '@/app/(brand)/actions'
import { formatKrDown, participantShare, reservationOre } from '@/lib/money/calc'
import { DEFAULTS, FLOORS, sek } from '@/lib/money/rates'

type Draft = {
  id: string
  name: string
  startsAt: string | null
  endsAt: string | null
  goLiveAt: string | null
  cities: string[]
  ageBrackets: string[]
  minFollowers: number
  maxFollowers: number | null
  categories: string[]
  exclusions: string[]
  rulesText: string | null
  brandSafety: string[]
  reviewTier: 'A' | 'B'
  disclosureText: string
  budget: number
  perPlacementMax: number
  perPersonCap: number
  fundedVia: string | null
  state: string
  forceTierB: boolean
  template: {
    kind: 'FIXED' | 'CPM' | 'HYBRID' | 'HYBRID_BONUS'
    fixedOre: number
    cpmOre: number
    bonusAtViews: number | null
    bonusOre: number | null
    viewFloor: number
  } | null
  /** Eligible accounts and their average views, for the fill-rate preview. */
  eligibleAccounts: number
  medianAvgViews: number
  /** Measured rates from completed campaigns; null until there is history. */
  rates: {
    claimRate: number
    completionRate: number
    medianDaysToFill: number
    sampleSize: number
  } | null
}

const CITIES = ['stockholm', 'goteborg', 'malmo', 'uppsala']
const AGE_BRACKETS = ['18-20', '21-25', '26-30', '31+']
const CATEGORIES = ['gym', 'food', 'study', 'travel', 'fashion', 'gaming', 'nightlife', 'hobby']

const STEPS = ['Basics', 'Audience', 'Assets', 'Rules', 'Payout', 'Budget'] as const

/**
 * Campaign builder — docs/02 B1. Six steps, each saving its own slice so a draft is
 * never lost mid-way.
 */
export function CampaignBuilder({ draft }: { draft: Draft }) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: draft.name,
    endsAt: draft.endsAt?.slice(0, 10) ?? '',
    goLiveAt: draft.goLiveAt?.slice(0, 16) ?? '',
    cities: draft.cities.length > 0 ? draft.cities : ['stockholm'],
    ageBrackets: draft.ageBrackets.length > 0 ? draft.ageBrackets : AGE_BRACKETS.slice(0, 3),
    minFollowers: draft.minFollowers,
    maxFollowers: draft.maxFollowers,
    categories: draft.categories,
    exclusions: draft.exclusions,
    rulesText: draft.rulesText ?? '',
    brandSafety: draft.brandSafety,
    reviewTier: draft.forceTierB ? ('B' as const) : draft.reviewTier,
    disclosureText: draft.disclosureText,
    kind: draft.template?.kind ?? ('HYBRID' as const),
    fixedOre: draft.template?.fixedOre ?? DEFAULTS.fixedOre,
    cpmOre: draft.template?.cpmOre ?? DEFAULTS.cpmOre,
    bonusAtViews: draft.template?.bonusAtViews ?? DEFAULTS.bonusAtViews,
    bonusOre: draft.template?.bonusOre ?? DEFAULTS.bonusOre,
    viewFloor: draft.template?.viewFloor ?? DEFAULTS.viewFloor,
    budgetOre: draft.budget || sek(25_000),
    perPlacementMaxOre: draft.perPlacementMax,
    perPersonCap: draft.perPersonCap,
    fundedVia: (draft.fundedVia as 'card' | 'invoice') ?? 'card',
  })

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const toggle = (key: 'cities' | 'ageBrackets' | 'categories', value: string) =>
    setForm((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((v) => v !== value)
        : [...current[key], value],
    }))

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, next?: number) {
    setPending(true)
    setError(null)
    const result = await fn()
    setPending(false)
    if (result.ok) {
      if (next !== undefined) setStep(next)
      router.refresh()
    } else {
      setError(result.error ?? 'error')
    }
  }

  // Fill forecast — docs/02 B1 step 5. Recomputed live as the brand moves the price,
  // so it must stay synchronous; `estimateFill` in lib/fill-model.ts is the same
  // arithmetic on the server for anything that needs it off-screen.
  const template = {
    fixedOre: form.fixedOre,
    cpmOre: form.cpmOre,
    viewFloor: form.viewFloor,
    takeRateBps: DEFAULTS.takeRateBps,
    bonusAtViews: form.kind === 'HYBRID_BONUS' ? form.bonusAtViews : null,
    bonusOre: form.kind === 'HYBRID_BONUS' ? form.bonusOre : null,
  }
  const perPlacement = reservationOre(
    template,
    { avgViews30d: draft.medianAvgViews || 450 },
    form.perPlacementMaxOre,
  )
  const placementsAffordable = perPlacement > 0 ? Math.floor(form.budgetOre / perPlacement) : 0

  // With measured rates the forecast is capped by whichever runs out first, money or
  // willing participants. Without them it is the budget-capacity upper bound.
  const expectedClaims = draft.rates
    ? Math.floor(draft.eligibleAccounts * draft.rates.claimRate)
    : draft.eligibleAccounts
  const expectedCompleted = draft.rates
    ? Math.floor(Math.min(expectedClaims, placementsAffordable) * draft.rates.completionRate)
    : Math.min(expectedClaims, placementsAffordable)

  const fillPercent =
    placementsAffordable > 0
      ? Math.min(100, Math.round((expectedCompleted / placementsAffordable) * 100))
      : 0

  const demandRatio = placementsAffordable > 0 ? expectedClaims / placementsAffordable : 0
  const estimatedDays = draft.rates
    ? demandRatio >= 1
      ? Math.max(1, Math.round(draft.rates.medianDaysToFill / Math.max(1, demandRatio)))
      : Math.round(draft.rates.medianDaysToFill)
    : placementsAffordable > 0
      ? Math.max(1, Math.ceil(placementsAffordable / 25))
      : 0

  return (
    <div className="max-w-2xl">
      <ol className="flex flex-wrap gap-2 mb-6 text-xs">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button
              type="button"
              className="chip"
              aria-pressed={step === index}
              onClick={() => setStep(index)}
            >
              {index + 1}. {label}
            </button>
          </li>
        ))}
      </ol>

      {error && (
        <p className="error-text mb-4" role="alert">
          {error}
        </p>
      )}

      {step === 0 && (
        <section className="card p-5 grid gap-4">
          <div>
            <label className="label" htmlFor="cb-name">
              Name
            </label>
            <input id="cb-name" className="field" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="cb-ends">
                Ends
              </label>
              <input
                id="cb-ends"
                type="date"
                className="field"
                value={form.endsAt}
                onChange={(e) => set('endsAt', e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="cb-golive">
                Go live
              </label>
              <input
                id="cb-golive"
                type="datetime-local"
                className="field"
                value={form.goLiveAt}
                onChange={(e) => set('goLiveAt', e.target.value)}
              />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  saveBasics(draft.id, {
                    name: form.name,
                    endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
                    goLiveAt: form.goLiveAt ? new Date(form.goLiveAt).toISOString() : null,
                  }),
                1,
              )
            }
          >
            Next
          </button>
        </section>
      )}

      {step === 1 && (
        <section className="card p-5 grid gap-4">
          <fieldset>
            <legend className="label">Cities</legend>
            <div className="flex flex-wrap gap-2">
              {CITIES.map((city) => (
                <button
                  key={city}
                  type="button"
                  className="chip"
                  aria-pressed={form.cities.includes(city)}
                  onClick={() => toggle('cities', city)}
                >
                  {city}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="label">Age</legend>
            <div className="flex flex-wrap gap-2">
              {AGE_BRACKETS.map((age) => (
                <button
                  key={age}
                  type="button"
                  className="chip"
                  aria-pressed={form.ageBrackets.includes(age)}
                  onClick={() => toggle('ageBrackets', age)}
                >
                  {age}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="cb-minf">
                Min followers
              </label>
              <input
                id="cb-minf"
                type="number"
                min={0}
                className="field"
                value={form.minFollowers}
                onChange={(e) => set('minFollowers', Number(e.target.value))}
              />
            </div>
            <div>
              <label className="label" htmlFor="cb-maxf">
                Max followers
              </label>
              <input
                id="cb-maxf"
                type="number"
                min={0}
                className="field"
                value={form.maxFollowers ?? ''}
                onChange={(e) => set('maxFollowers', e.target.value ? Number(e.target.value) : null)}
              />
            </div>
          </div>

          <fieldset>
            <legend className="label">Categories</legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  className="chip"
                  aria-pressed={form.categories.includes(category)}
                  onClick={() => toggle('categories', category)}
                >
                  {category}
                </button>
              ))}
            </div>
          </fieldset>

          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  saveAudience(draft.id, {
                    cities: form.cities,
                    ageBrackets: form.ageBrackets,
                    minFollowers: form.minFollowers,
                    maxFollowers: form.maxFollowers,
                    categories: form.categories,
                    exclusions: form.exclusions,
                  }),
                2,
              )
            }
          >
            Next
          </button>
        </section>
      )}

      {step === 2 && (
        <section className="card p-5 grid gap-4">
          <p className="text-sm text-[var(--color-ink-2)]">
            Upload product images (PNG with alpha preferred). Assets are managed on the campaign page.
          </p>
          <a href={`/brand/campaigns/${draft.id}/assets`} className="btn btn-secondary">
            Manage assets
          </a>
          <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>
            Next
          </button>
        </section>
      )}

      {step === 3 && (
        <section className="card p-5 grid gap-4">
          <div>
            <label className="label" htmlFor="cb-rules">
              Placement rules
            </label>
            <textarea
              id="cb-rules"
              rows={4}
              className="field"
              value={form.rulesText}
              onChange={(e) => set('rulesText', e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="cb-tier">
              Review tier
            </label>
            <select
              id="cb-tier"
              className="field"
              value={form.reviewTier}
              disabled={draft.forceTierB}
              onChange={(e) => set('reviewTier', e.target.value as 'A' | 'B')}
            >
              <option value="B">B — review every placement</option>
              <option value="A">A — auto-approve with a 5% sample</option>
            </select>
            {draft.forceTierB && (
              <p className="text-xs text-[var(--color-ink-3)] mt-1">
                Tier B is required on a brand&apos;s first campaign.
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="cb-disc">
              Ad disclosure
            </label>
            <input
              id="cb-disc"
              className="field"
              value={form.disclosureText}
              onChange={(e) => set('disclosureText', e.target.value)}
            />
            <p className="text-xs text-[var(--color-ink-3)] mt-1">
              Must start with Reklam or Annons. It cannot be removed.
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  saveRules(draft.id, {
                    rulesText: form.rulesText,
                    brandSafety: form.brandSafety,
                    reviewTier: form.reviewTier,
                    disclosureText: form.disclosureText,
                  }),
                4,
              )
            }
          >
            Next
          </button>
        </section>
      )}

      {step === 4 && (
        <section className="card p-5 grid gap-4">
          <div>
            <label className="label" htmlFor="cb-kind">
              Template
            </label>
            <select
              id="cb-kind"
              className="field"
              value={form.kind}
              onChange={(e) => set('kind', e.target.value as typeof form.kind)}
            >
              <option value="HYBRID">Hybrid — fixed + CPM</option>
              <option value="FIXED">Fixed only</option>
              <option value="CPM">CPM only</option>
              <option value="HYBRID_BONUS">Hybrid + bonus</option>
            </select>
          </div>

          {form.kind !== 'CPM' && (
            <div>
              <label className="label" htmlFor="cb-fixed">
                Fixed per placement (kr) — floor {FLOORS.fixedOre / 100}
              </label>
              <input
                id="cb-fixed"
                type="number"
                min={FLOORS.fixedOre / 100}
                className="field"
                value={form.fixedOre / 100}
                onChange={(e) => set('fixedOre', Math.round(Number(e.target.value) * 100))}
              />
            </div>
          )}

          {form.kind !== 'FIXED' && (
            <div>
              <label className="label" htmlFor="cb-cpm">
                CPM per 1,000 qualified views (kr) — floor {FLOORS.cpmOre / 100}
              </label>
              <input
                id="cb-cpm"
                type="number"
                min={FLOORS.cpmOre / 100}
                className="field"
                value={form.cpmOre / 100}
                onChange={(e) => set('cpmOre', Math.round(Number(e.target.value) * 100))}
              />
            </div>
          )}

          {form.kind === 'HYBRID_BONUS' && (
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="label" htmlFor="cb-bonus-at">
                  Bonus at views
                </label>
                <input
                  id="cb-bonus-at"
                  type="number"
                  className="field"
                  value={form.bonusAtViews}
                  onChange={(e) => set('bonusAtViews', Number(e.target.value))}
                />
              </div>
              <div>
                <label className="label" htmlFor="cb-bonus">
                  Bonus (kr)
                </label>
                <input
                  id="cb-bonus"
                  type="number"
                  className="field"
                  value={form.bonusOre / 100}
                  onChange={(e) => set('bonusOre', Math.round(Number(e.target.value) * 100))}
                />
              </div>
            </div>
          )}

          <div className="card p-4 bg-[var(--color-bg)]">
            <p className="text-sm mb-1">
              Participants see:{' '}
              <strong className="amount">
                {formatKrDown(participantShare(form.fixedOre))} per post +{' '}
                {formatKrDown(participantShare(form.cpmOre))} per 1,000 views
              </strong>
            </p>
            <p className="text-sm text-[var(--color-ink-2)]">
              At this price, expected fill ~{fillPercent}% in {estimatedDays} days (
              {placementsAffordable.toLocaleString('sv-SE')} placements at ~
              {formatKrDown(perPlacement)} reserved each).
            </p>
            <p className="text-xs text-[var(--color-ink-3)] mt-1">
              {draft.rates
                ? `Based on ${Math.round(draft.rates.claimRate * 100)}% claim and ${Math.round(
                    draft.rates.completionRate * 100,
                  )}% completion measured across ${draft.rates.sampleSize} completed ${
                    draft.rates.sampleSize === 1 ? 'campaign' : 'campaigns'
                  }.`
                : `Upper bound: assumes every one of ${draft.eligibleAccounts.toLocaleString(
                    'sv-SE',
                  )} eligible accounts claims. Replaced by measured rates after the first campaign closes.`}
            </p>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  savePayoutTemplate(draft.id, {
                    kind: form.kind,
                    fixedOre: form.kind === 'CPM' ? 0 : form.fixedOre,
                    cpmOre: form.kind === 'FIXED' ? 0 : form.cpmOre,
                    bonusAtViews: form.kind === 'HYBRID_BONUS' ? form.bonusAtViews : null,
                    bonusOre: form.kind === 'HYBRID_BONUS' ? form.bonusOre : null,
                    viewFloor: form.viewFloor,
                  }),
                5,
              )
            }
          >
            Next
          </button>
        </section>
      )}

      {step === 5 && (
        <section className="card p-5 grid gap-4">
          <div>
            <label className="label" htmlFor="cb-budget">
              Budget (kr)
            </label>
            <input
              id="cb-budget"
              type="number"
              min={1}
              className="field"
              value={form.budgetOre / 100}
              onChange={(e) => set('budgetOre', Math.round(Number(e.target.value) * 100))}
            />
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="cb-max">
                Max per placement (kr)
              </label>
              <input
                id="cb-max"
                type="number"
                className="field"
                value={form.perPlacementMaxOre / 100}
                onChange={(e) => set('perPlacementMaxOre', Math.round(Number(e.target.value) * 100))}
              />
            </div>
            <div>
              <label className="label" htmlFor="cb-cap">
                Placements per person
              </label>
              <input
                id="cb-cap"
                type="number"
                min={1}
                className="field"
                value={form.perPersonCap}
                onChange={(e) => set('perPersonCap', Number(e.target.value))}
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="cb-funding">
              Funding
            </label>
            <select
              id="cb-funding"
              className="field"
              value={form.fundedVia}
              onChange={(e) => set('fundedVia', e.target.value as 'card' | 'invoice')}
            >
              <option value="card">Card (Stripe) — prepaid, no fee</option>
              <option value="invoice">Invoice net-30 — adds {DEFAULTS.creditTermsFeeBps / 100}%</option>
            </select>
          </div>

          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending}
            onClick={() =>
              run(() =>
                saveBudget(draft.id, {
                  budgetOre: form.budgetOre,
                  perPlacementMaxOre: form.perPlacementMaxOre,
                  perPersonCap: form.perPersonCap,
                  fundedVia: form.fundedVia,
                }),
              )
            }
          >
            Save
          </button>

          <button
            type="button"
            className="btn text-white"
            style={{ background: 'var(--color-blue)' }}
            disabled={pending}
            onClick={async () => {
              await run(() =>
                saveBudget(draft.id, {
                  budgetOre: form.budgetOre,
                  perPlacementMaxOre: form.perPlacementMaxOre,
                  perPersonCap: form.perPersonCap,
                  fundedVia: form.fundedVia,
                }),
              )
              await run(() => submitCampaign(draft.id))
              router.push(`/brand/campaigns/${draft.id}`)
            }}
          >
            Submit for review
          </button>
        </section>
      )}
    </div>
  )
}
