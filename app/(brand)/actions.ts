'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireBrandUser } from '@/lib/auth'
import { flag as readFlag } from '@/lib/flags'
import { depositProvider } from '@/lib/integrations/stripe'
import { creditTermsFeeOre } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import {
  assertDisclosureGuard,
  nextDropAt,
  pause,
  submit,
  resubmit,
} from '@/lib/state/campaign'
import { brandApprove, brandReject, raiseDispute } from '@/lib/state/placement'
import { GuardError } from '@/lib/state/transition'

/**
 * Brand Server Actions — docs/02 section B.
 *
 * Every action resolves the campaign's brandId first and passes it to requireBrandUser,
 * so a brand user cannot act on another brand's campaign by guessing an id.
 */

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const fail = (error: string): ActionResult<never> => ({ ok: false, error })

async function brandIdOf(campaignId: string): Promise<string> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { brandId: true },
  })
  return campaign.brandId
}

// ---------------------------------------------------------------- builder

const basicsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
  goLiveAt: z.string().datetime().optional().nullable(),
})

export async function createDraft(brandId: string, name: string): Promise<ActionResult<{ id: string }>> {
  await requireBrandUser(brandId)

  const campaign = await prisma.campaign.create({
    data: {
      brandId,
      name: name.trim().slice(0, 120) || 'Untitled campaign',
      state: 'DRAFT',
      goLiveAt: nextDropAt(),
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      budget: 0,
      perPlacementMax: DEFAULTS.perPlacementMaxOre,
      perPersonCap: DEFAULTS.perPersonCap,
    },
    select: { id: true },
  })

  revalidatePath('/campaigns')
  return { ok: true, data: { id: campaign.id } }
}

/** Step 1 — basics. Each builder step saves its own slice, so a draft is never lost. */
export async function saveBasics(campaignId: string, input: unknown): Promise<ActionResult> {
  await requireBrandUser(await brandIdOf(campaignId))

  const parsed = basicsSchema.safeParse(input)
  if (!parsed.success) return fail('invalid')

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      name: parsed.data.name,
      startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : undefined,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : undefined,
      goLiveAt: parsed.data.goLiveAt ? new Date(parsed.data.goLiveAt) : undefined,
    },
  })

  revalidatePath(`/campaigns/${campaignId}/edit`)
  return { ok: true }
}

/** Step 2 — audience. */
export async function saveAudience(campaignId: string, input: unknown): Promise<ActionResult> {
  await requireBrandUser(await brandIdOf(campaignId))

  const parsed = z
    .object({
      cities: z.array(z.string()).max(20),
      ageBrackets: z.array(z.enum(['18-20', '21-25', '26-30', '31+'])),
      minFollowers: z.number().int().min(0).max(1_000_000),
      maxFollowers: z.number().int().min(0).max(10_000_000).optional().nullable(),
      categories: z.array(z.string()).max(20),
      exclusions: z.array(z.string()).max(50),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  await prisma.campaign.update({ where: { id: campaignId }, data: parsed.data })
  revalidatePath(`/campaigns/${campaignId}/edit`)
  return { ok: true }
}

/** Step 4 — rules. The disclosure guard runs here as well as at submit. */
export async function saveRules(campaignId: string, input: unknown): Promise<ActionResult> {
  await requireBrandUser(await brandIdOf(campaignId))

  const parsed = z
    .object({
      rulesText: z.string().max(2000).optional().nullable(),
      brandSafety: z.array(z.string()).max(50),
      reviewTier: z.enum(['A', 'B']),
      disclosureText: z.string().min(1).max(300),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  try {
    assertDisclosureGuard(parsed.data.disclosureText)
  } catch (error) {
    return fail(error instanceof GuardError ? error.code : 'BAD_DISCLOSURE')
  }

  // Tier B is mandatory on a brand's first campaign (docs/02 B1 step 4).
  const brandId = await brandIdOf(campaignId)
  const priorCampaigns = await prisma.campaign.count({
    where: { brandId, state: { in: ['CLOSED', 'RECONCILING'] }, id: { not: campaignId } },
  })
  const forceTierB = await readFlag('review.firstCampaignForcesTierB')
  const reviewTier = forceTierB && priorCampaigns === 0 ? 'B' : parsed.data.reviewTier

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { ...parsed.data, reviewTier },
  })

  revalidatePath(`/campaigns/${campaignId}/edit`)
  return { ok: true }
}

/** Step 5 — payout template. Floors are enforced from the Flag table, not from code. */
export async function savePayoutTemplate(campaignId: string, input: unknown): Promise<ActionResult> {
  await requireBrandUser(await brandIdOf(campaignId))

  const parsed = z
    .object({
      kind: z.enum(['FIXED', 'CPM', 'HYBRID', 'HYBRID_BONUS']),
      fixedOre: z.number().int().min(0),
      cpmOre: z.number().int().min(0),
      bonusAtViews: z.number().int().min(0).optional().nullable(),
      bonusOre: z.number().int().min(0).optional().nullable(),
      viewFloor: z.number().int().min(0),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  const [floorCpm, floorFixed, floorViews] = await Promise.all([
    readFlag('pricing.floor.cpmOre'),
    readFlag('pricing.floor.fixedOre'),
    readFlag('pricing.floor.viewFloor'),
  ])

  const usesCpm = parsed.data.kind !== 'FIXED'
  const usesFixed = parsed.data.kind !== 'CPM'

  if (usesCpm && parsed.data.cpmOre < floorCpm) return fail('cpmBelowFloor')
  if (usesFixed && parsed.data.fixedOre < floorFixed) return fail('fixedBelowFloor')
  if (parsed.data.viewFloor < floorViews) return fail('viewFloorTooLow')
  if (parsed.data.kind === 'HYBRID_BONUS' && (!parsed.data.bonusAtViews || !parsed.data.bonusOre)) {
    return fail('bonusRequired')
  }

  await prisma.payoutTemplate.upsert({
    where: { campaignId },
    create: { campaignId, ...parsed.data, takeRateBps: DEFAULTS.takeRateBps },
    update: parsed.data,
  })

  revalidatePath(`/campaigns/${campaignId}/edit`)
  return { ok: true }
}

/** Step 6 — budget and funding. */
export async function saveBudget(campaignId: string, input: unknown): Promise<ActionResult> {
  await requireBrandUser(await brandIdOf(campaignId))

  const parsed = z
    .object({
      budgetOre: z.number().int().min(100),
      perPlacementMaxOre: z.number().int().min(100),
      perPersonCap: z.number().int().min(1).max(10),
      fundedVia: z.enum(['card', 'invoice']),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  const floorCap = await readFlag('pricing.floor.perPersonCap')
  if (parsed.data.perPersonCap < floorCap) return fail('capTooLow')

  if (parsed.data.fundedVia === 'invoice' && !(await readFlag('funding.invoiceEnabled'))) {
    return fail('invoiceDisabled')
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      budget: parsed.data.budgetOre,
      perPlacementMax: parsed.data.perPlacementMaxOre,
      perPersonCap: parsed.data.perPersonCap,
      fundedVia: parsed.data.fundedVia,
      creditTermsFeeBps: parsed.data.fundedVia === 'invoice' ? DEFAULTS.creditTermsFeeBps : 0,
    },
  })

  revalidatePath(`/campaigns/${campaignId}/edit`)
  return { ok: true }
}

export async function submitCampaign(campaignId: string): Promise<ActionResult> {
  const brandUser = await requireBrandUser(await brandIdOf(campaignId))

  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { state: true },
  })

  try {
    const actor = { kind: 'BRAND' as const, id: brandUser.id }
    if (campaign.state === 'RETURNED') await resubmit(campaignId, actor)
    else await submit(campaignId, actor)
  } catch (error) {
    return fail(error instanceof GuardError ? error.code : 'submitFailed')
  }

  revalidatePath('/campaigns')
  return { ok: true }
}

/** Stripe Checkout for the deposit. The webhook, not this call, marks the campaign FUNDED. */
export async function startCheckout(campaignId: string): Promise<ActionResult<{ url: string }>> {
  const brandUser = await requireBrandUser(await brandIdOf(campaignId))

  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { state: true, budget: true, creditTermsFeeBps: true },
  })
  if (campaign.state !== 'AWAITING_FUNDS') return fail('notAwaitingFunds')

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const total = campaign.budget + creditTermsFeeOre(campaign.budget, campaign.creditTermsFeeBps)

  const { url, sessionId } = await depositProvider().createCheckout({
    campaignId,
    amountOre: total,
    brandEmail: brandUser.email,
    successUrl: `${siteUrl}/campaigns/${campaignId}?funded=1`,
    cancelUrl: `${siteUrl}/campaigns/${campaignId}`,
  })

  await prisma.campaign.update({ where: { id: campaignId }, data: { stripeSessionId: sessionId } })
  return { ok: true, data: { url } }
}

/** Step 3 — assets. Uploaded through a Server Action so the file never needs a public bucket. */
export async function uploadCampaignAsset(formData: FormData): Promise<ActionResult> {
  const campaignId = String(formData.get('campaignId') ?? '')
  if (!campaignId) return fail('invalid')

  await requireBrandUser(await brandIdOf(campaignId))

  const file = formData.get('file')
  const name = String(formData.get('name') ?? '').trim().slice(0, 120)
  const placementTypes = String(formData.get('placementTypes') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  if (!(file instanceof File) || !name) return fail('invalid')
  if (file.size > 8 * 1024 * 1024) return fail('tooLarge')

  const { extensionFor, paths, put } = await import('@/lib/storage')

  const asset = await prisma.campaignAsset.create({
    data: { campaignId, name, storagePath: '', placementTypes },
    select: { id: true },
  })

  const buffer = Buffer.from(await file.arrayBuffer())
  const storagePath = paths.asset(campaignId, asset.id, extensionFor(file.type))
  await put(storagePath, buffer, file.type)

  await prisma.campaignAsset.update({ where: { id: asset.id }, data: { storagePath } })

  revalidatePath(`/brand/campaigns/${campaignId}/assets`)
  return { ok: true }
}

// ---------------------------------------------------------------- review queue

export async function approvePlacementAsBrand(placementId: string): Promise<ActionResult> {
  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { campaign: { select: { brandId: true } } },
  })
  const brandUser = await requireBrandUser(placement.campaign.brandId)

  await brandApprove(placementId, { kind: 'BRAND', id: brandUser.id })
  revalidatePath('/campaigns')
  return { ok: true }
}

export async function rejectPlacementAsBrand(placementId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { campaign: { select: { brandId: true } } },
  })
  const brandUser = await requireBrandUser(placement.campaign.brandId)

  await brandReject(placementId, parsed.data, { kind: 'BRAND', id: brandUser.id })
  revalidatePath('/campaigns')
  return { ok: true }
}

// ---------------------------------------------------------------- lifecycle

export async function pauseCampaign(campaignId: string, reason: string): Promise<ActionResult> {
  const brandUser = await requireBrandUser(await brandIdOf(campaignId))

  try {
    await pause(campaignId, reason.slice(0, 500) || 'Paused by brand', { kind: 'BRAND', id: brandUser.id })
  } catch {
    return fail('cannotPause')
  }

  revalidatePath(`/campaigns/${campaignId}`)
  return { ok: true }
}

/**
 * A dispute during the 7-day window. It never reverses a payout on its own — ops
 * reviews checks 2 and 3 and decides (docs/03 edge case 8).
 */
export async function disputePlacement(placementId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(1000).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { state: true, campaign: { select: { brandId: true, disputeWindowEndsAt: true } } },
  })
  const brandUser = await requireBrandUser(placement.campaign.brandId)

  const windowEnd = placement.campaign.disputeWindowEndsAt
  if (!windowEnd || windowEnd < new Date()) return fail('windowClosed')
  if (placement.state !== 'PAID') return fail('notDisputable')

  await raiseDispute(placementId, parsed.data, { kind: 'BRAND', id: brandUser.id })
  revalidatePath(`/campaigns`)
  return { ok: true }
}

export async function setRolloverPreference(
  brandId: string,
  preference: 'refund' | 'rollover',
): Promise<ActionResult> {
  await requireBrandUser(brandId)
  await prisma.brand.update({ where: { id: brandId }, data: { rolloverPreference: preference } })
  revalidatePath('/settings')
  return { ok: true }
}
