'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { referralCode } from '@/lib/crypto'
import { setFlag, type FlagKey } from '@/lib/flags'
import { sendBrandUserInvite } from '@/lib/email'
import { extensionFor, paths, put } from '@/lib/storage'
import { perceptualHash } from '@/lib/media'
import { approve as approveCampaign, close, reconcile, returnToBrand, pause } from '@/lib/state/campaign'
import { generationDone, generationFailed, reject, resolveDispute, retryGeneration } from '@/lib/state/placement'
import { renderPlacement } from '@/lib/render'
import { clearFlag, flag as flagParticipant, remove, restore, suspend } from '@/lib/state/participant'
import { clearFlagAndQualify, confirmFraud, verify } from '@/lib/state/verification'
import { closePayoutBatch, markPayoutSent, openPayoutBatch } from '@/lib/state/money'
import { auditAction, type ActorRef } from '@/lib/state/transition'
import { emit } from '@/lib/events'

/**
 * Ops Server Actions — docs/02 section C.
 *
 * Everything here is audited with a mandatory reason where the spec requires one
 * ("force state transitions with mandatory reason (audited)"). requireOps() redirects
 * anyone else away before a single query runs.
 */

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const fail = (error: string): ActionResult<never> => ({ ok: false, error })

async function opsActor(): Promise<ActorRef> {
  const user = await requireOps()
  return { kind: 'OPS', id: user.id }
}

// ---------------------------------------------------------------- campaigns

export async function opsApproveCampaign(campaignId: string): Promise<ActionResult> {
  const actor = await opsActor()
  await approveCampaign(campaignId, actor)
  revalidatePath('/ops/campaigns')
  return { ok: true }
}

export async function opsReturnCampaign(campaignId: string, notes: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(2000).safeParse(notes)
  if (!parsed.success) return fail('notesRequired')

  const actor = await opsActor()
  await returnToBrand(campaignId, parsed.data, actor)
  revalidatePath('/ops/campaigns')
  return { ok: true }
}

/**
 * Manual funding for the invoice path — docs/06 section 4. Only for brands ops has
 * whitelisted, and only when the flag allows funding before cash arrives.
 */
export async function opsFundCampaign(campaignId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { budget: true, fundedVia: true, brand: { select: { invoiceWhitelisted: true } } },
  })

  if (campaign.fundedVia !== 'invoice') return fail('notInvoice')
  if (!campaign.brand.invoiceWhitelisted) return fail('notWhitelisted')

  const { fund } = await import('@/lib/state/campaign')
  await fund(campaignId, { amountOre: campaign.budget, via: 'invoice' }, actor)
  await auditAction(prisma, 'Campaign', campaignId, 'OPS_FUND', actor, undefined, parsed.data)

  revalidatePath('/ops/campaigns')
  return { ok: true }
}

export async function opsPauseCampaign(campaignId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await pause(campaignId, parsed.data, actor)
  revalidatePath('/ops/campaigns')
  return { ok: true }
}

export async function opsReconcileCampaign(campaignId: string): Promise<ActionResult> {
  const actor = await opsActor()
  try {
    await reconcile(campaignId, actor)
  } catch {
    return fail('openPlacements')
  }
  revalidatePath('/ops/campaigns')
  return { ok: true }
}

export async function opsCloseCampaign(
  campaignId: string,
  mode: 'refund' | 'rollover',
): Promise<ActionResult<{ returnedOre: number }>> {
  const actor = await opsActor()
  const { returnedOre } = await close(campaignId, { mode }, actor)
  revalidatePath('/ops/campaigns')
  return { ok: true, data: { returnedOre } }
}

// ---------------------------------------------------------------- generation queue

/**
 * The manual placement engine — docs/06 section 6, OpsQueueEngine.
 * A human composites the image in any tool and uploads the result here, which is what
 * moves the placement to PARTICIPANT_REVIEW.
 */
export async function opsUploadGeneratedVersion(formData: FormData): Promise<ActionResult> {
  const actor = await opsActor()

  const placementId = String(formData.get('placementId') ?? '')
  const file = formData.get('file')
  if (!placementId || !(file instanceof File)) return fail('invalid')

  const placement = await prisma.placement.findUnique({
    where: { id: placementId },
    select: { state: true },
  })
  if (!placement || placement.state !== 'GENERATING') return fail('wrongState')

  const buffer = Buffer.from(await file.arrayBuffer())
  const versionId = referralCode().toLowerCase()
  const storagePath = paths.version(placementId, versionId, extensionFor(file.type))
  await put(storagePath, buffer, file.type)

  await generationDone(placementId, { storagePath, engine: 'ops-queue' }, actor)
  revalidatePath('/ops/generation')
  return { ok: true }
}

export async function opsFailGeneration(placementId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await generationFailed(placementId, parsed.data, actor)
  revalidatePath('/ops/generation')
  return { ok: true }
}

/**
 * Runs the automatic engine on a job sitting in the queue. Useful when the flag was off
 * when the placement arrived, or when a failed job should be retried now rather than
 * after the backoff. A GENERATION_FAILED job is put back into GENERATING first.
 */
export async function opsRunEngine(placementId: string): Promise<ActionResult<{ outcome: string }>> {
  const actor = await opsActor()

  const placement = await prisma.placement.findUnique({ where: { id: placementId }, select: { state: true } })
  if (!placement) return fail('notFound')
  if (placement.state === 'GENERATION_FAILED') await retryGeneration(placementId, actor)
  else if (placement.state !== 'GENERATING') return fail('wrongState')

  const outcome = await renderPlacement(placementId, actor)
  revalidatePath('/ops/generation')
  return outcome === 'rendered' || outcome === 'deferred' ? { ok: true, data: { outcome } } : fail(outcome)
}

// ---------------------------------------------------------------- verification queue

/**
 * Screenshot-tier verification: ops enters the view count from the screenshot and the
 * pipeline runs the same checks it runs for API-tier placements.
 *
 * Note there is no "override disclosure" parameter here, and there never will be
 * (CLAUDE.md rule 5).
 */
export async function opsVerifyFromScreenshot(input: unknown): Promise<ActionResult<{ decision: string }>> {
  const actor = await opsActor()

  const parsed = z
    .object({
      placementId: z.string().min(1),
      views: z.number().int().min(0),
      caption: z.string().max(4000),
      hasPaidPartnershipLabel: z.boolean(),
      stillLive: z.boolean().default(true),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  const outcome = await verify(
    {
      placementId: parsed.data.placementId,
      observedPlatformUserId: null,
      caption: parsed.data.caption,
      hasPaidPartnershipLabel: parsed.data.hasPaidPartnershipLabel,
      publishedHash: null,
      views: parsed.data.views,
      viewsSource: 'screenshot',
      stillLive: parsed.data.stillLive,
    },
    actor,
  )

  revalidatePath('/ops/verification')
  return { ok: true, data: { decision: outcome.decision } }
}

export async function opsUploadScreenshot(formData: FormData): Promise<ActionResult> {
  await opsActor()

  const placementId = String(formData.get('placementId') ?? '')
  const file = formData.get('file')
  if (!placementId || !(file instanceof File)) return fail('invalid')

  const buffer = Buffer.from(await file.arrayBuffer())
  const storagePath = paths.screenshot(placementId, extensionFor(file.type))
  await put(storagePath, buffer, file.type)

  await prisma.verification.upsert({
    where: { placementId },
    create: { placementId, screenshotPath: storagePath, viewsSource: 'screenshot' },
    update: { screenshotPath: storagePath },
  })

  revalidatePath('/ops/verification')
  return { ok: true }
}

/** Ops clears a fraud flag — the placement pays at the reservation cap. */
export async function opsClearFraudFlag(placementId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await auditAction(prisma, 'Placement', placementId, 'OPS_CLEAR_FLAG', actor, undefined, parsed.data)
  await clearFlagAndQualify(placementId, actor)

  revalidatePath('/ops/verification')
  return { ok: true }
}

export async function opsConfirmFraud(placementId: string, note: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(note)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await confirmFraud(placementId, parsed.data, actor)
  revalidatePath('/ops/verification')
  return { ok: true }
}

export async function opsRejectPlacement(input: unknown): Promise<ActionResult> {
  const actor = await opsActor()

  const parsed = z
    .object({
      placementId: z.string().min(1),
      reason: z.enum(['NO_DISCLOSURE', 'MEDIA_MISMATCH', 'WRONG_ACCOUNT', 'DELETED_EARLY', 'FRAUD', 'BRAND_SAFETY', 'OTHER']),
      note: z.string().max(500).optional(),
      strike: z.enum(['MINOR', 'SERIOUS']).optional(),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  await reject(parsed.data, actor)
  revalidatePath('/ops/verification')
  return { ok: true }
}

// ---------------------------------------------------------------- disputes

/**
 * Edge case 8: ops reviews checks 2 and 3 only; payouts stand unless proven, and NOD
 * absorbs the cost in the pilot.
 */
export async function opsResolveDispute(
  placementId: string,
  upheld: boolean,
  resolution: string,
): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(2000).safeParse(resolution)
  if (!parsed.success) return fail('resolutionRequired')

  const actor = await opsActor()
  await resolveDispute(placementId, { upheld, resolution: parsed.data }, actor)
  revalidatePath('/ops/verification')
  return { ok: true }
}

// ---------------------------------------------------------------- payouts

export async function opsOpenPayoutBatch(): Promise<
  ActionResult<{ batchId: string; csv: string; totalOre: number; rows: number }>
> {
  const actor = await opsActor()
  const batch = await openPayoutBatch(actor)
  revalidatePath('/ops/payouts')
  return {
    ok: true,
    data: { batchId: batch.batchId, csv: batch.csv, totalOre: batch.totalOre, rows: batch.rows.length },
  }
}

export async function opsMarkPayoutSent(input: unknown): Promise<ActionResult> {
  const actor = await opsActor()

  const parsed = z
    .object({
      batchId: z.string().min(1),
      walletId: z.string().min(1),
      amountOre: z.number().int().min(1),
      reference: z.string().trim().min(1).max(120),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  try {
    await markPayoutSent(parsed.data, actor)
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'payoutFailed')
  }

  const wallet = await prisma.wallet.findUnique({
    where: { id: parsed.data.walletId },
    select: { userId: true },
  })
  if (wallet) {
    const { notifyPayoutSent } = await import('@/lib/notify')
    await notifyPayoutSent(wallet.userId, parsed.data.amountOre)
  }

  revalidatePath('/ops/payouts')
  return { ok: true }
}

export async function opsCloseBatch(batchId: string): Promise<ActionResult> {
  const actor = await opsActor()
  await closePayoutBatch(batchId, actor)
  revalidatePath('/ops/payouts')
  return { ok: true }
}

// ---------------------------------------------------------------- participants

export async function opsFlagParticipant(userId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await flagParticipant(userId, parsed.data, actor)
  revalidatePath('/ops/participants')
  return { ok: true }
}

export async function opsClearParticipantFlag(userId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await clearFlag(userId, parsed.data, actor)
  revalidatePath('/ops/participants')
  return { ok: true }
}

export async function opsSuspendParticipant(userId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await suspend(userId, parsed.data, actor)
  revalidatePath('/ops/participants')
  return { ok: true }
}

export async function opsRestoreParticipant(userId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await restore(userId, parsed.data, actor)
  revalidatePath('/ops/participants')
  return { ok: true }
}

export async function opsRemoveParticipant(userId: string, reason: string): Promise<ActionResult> {
  const parsed = z.string().trim().min(1).max(500).safeParse(reason)
  if (!parsed.success) return fail('reasonRequired')

  const actor = await opsActor()
  await remove(userId, parsed.data, actor)
  revalidatePath('/ops/participants')
  return { ok: true }
}

/** Ops enters follower and view numbers for a screenshot-tier account. */
export async function opsUpdateAccountStats(input: unknown): Promise<ActionResult> {
  const actor = await opsActor()

  const parsed = z
    .object({
      accountId: z.string().min(1),
      followers: z.number().int().min(0),
      avgViews30d: z.number().int().min(0),
      tier: z.enum(['CONNECTED_API', 'CONNECTED_SCREENSHOT', 'BELOW_FLOOR', 'DISCONNECTED']),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  await prisma.socialAccount.update({
    where: { id: parsed.data.accountId },
    data: {
      followers: parsed.data.followers,
      avgViews30d: parsed.data.avgViews30d,
      tier: parsed.data.tier,
      lastSyncedAt: new Date(),
    },
  })

  await auditAction(prisma, 'SocialAccount', parsed.data.accountId, 'OPS_UPDATE_STATS', actor, {
    followers: parsed.data.followers,
    avgViews30d: parsed.data.avgViews30d,
  })

  revalidatePath('/ops/participants')
  return { ok: true }
}

// ---------------------------------------------------------------- brands

export async function opsCreateBrand(input: unknown): Promise<ActionResult<{ brandId: string }>> {
  const actor = await opsActor()

  const parsed = z
    .object({
      name: z.string().trim().min(1).max(120),
      orgNumber: z.string().trim().max(40).optional().nullable(),
      adminEmail: z.string().trim().toLowerCase().email(),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  const brand = await prisma.brand.create({
    data: { name: parsed.data.name, orgNumber: parsed.data.orgNumber ?? null },
    select: { id: true, name: true },
  })

  // The authId is filled in when the invitee first signs in with the magic link.
  await prisma.brandUser.create({
    data: {
      brandId: brand.id,
      authId: `pending:${brand.id}:${parsed.data.adminEmail}`,
      email: parsed.data.adminEmail,
      role: 'admin',
    },
  })

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  await sendBrandUserInvite({
    email: parsed.data.adminEmail,
    brandName: brand.name,
    link: `${siteUrl}/brand/sign-in`,
  })

  await auditAction(prisma, 'Brand', brand.id, 'OPS_CREATE_BRAND', actor, { name: brand.name })
  revalidatePath('/ops/brands')
  return { ok: true, data: { brandId: brand.id } }
}

export async function opsSetInvoiceWhitelist(brandId: string, whitelisted: boolean): Promise<ActionResult> {
  const actor = await opsActor()
  await prisma.brand.update({ where: { id: brandId }, data: { invoiceWhitelisted: whitelisted } })
  await auditAction(prisma, 'Brand', brandId, 'OPS_SET_INVOICE_WHITELIST', actor, { whitelisted })
  revalidatePath('/ops/brands')
  return { ok: true }
}

// ---------------------------------------------------------------- flags

export async function opsSetFlag(key: string, value: unknown): Promise<ActionResult> {
  const actor = await opsActor()

  const { FLAG_DEFAULTS } = await import('@/lib/flags')
  if (!(key in FLAG_DEFAULTS)) return fail('unknownFlag')

  await setFlag(key as FlagKey, value as never)
  await auditAction(prisma, 'Flag', key, 'OPS_SET_FLAG', actor, { value: value as never })

  revalidatePath('/ops/flags')
  return { ok: true }
}

// ---------------------------------------------------------------- media hashing

/** Recompute a placement's hash from a re-uploaded original. Used when ops repairs data. */
export async function opsRehashOriginal(placementId: string, formData: FormData): Promise<ActionResult> {
  await opsActor()

  const file = formData.get('file')
  if (!(file instanceof File)) return fail('invalid')

  const buffer = Buffer.from(await file.arrayBuffer())
  const hash = await perceptualHash(buffer)

  await prisma.placement.update({ where: { id: placementId }, data: { originalHash: hash } })
  await emit({ name: 'placement/uploaded', data: { placementId, rehashed: true } })

  revalidatePath('/ops/generation')
  return { ok: true }
}
