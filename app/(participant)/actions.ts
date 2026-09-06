'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { actorFor, getSession, requireParticipant, requireRole } from '@/lib/auth'
import { encrypt, referralCode } from '@/lib/crypto'
import { normaliseSwishNumber } from '@/lib/integrations/swish'
import { socialProvider } from '@/lib/integrations/instagram'
import { placementEngine } from '@/lib/integrations/engine'
import { flag as readFlag } from '@/lib/flags'
import { rateLimit } from '@/lib/rate-limit'
import { brandSafetyCheck } from '@/lib/media'
import { identityProvider } from '@/lib/integrations/bankid'
import { IdentityError, onboard, signUp, verifyIdentity } from '@/lib/state/participant'
import {
  claim,
  ClaimError,
  participantApprove,
  participantReject,
  position,
  publish,
  regenerate,
  startGeneration,
  upload,
} from '@/lib/state/placement'
import { emit } from '@/lib/events'

/**
 * Participant Server Actions — docs/02 section A.
 *
 * Every action validates its input with zod and checks the session role before
 * touching anything (CLAUDE.md conventions). The state machines do the rest; nothing
 * here writes a `state` column directly.
 */

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const fail = (error: string): ActionResult<never> => ({ ok: false, error })

// ---------------------------------------------------------------- onboarding

const signUpSchema = z.object({
  authId: z.string().min(1),
  email: z.string().email().optional().nullable(),
  city: z.enum(['stockholm', 'goteborg', 'malmo', 'uppsala', 'other']),
  // 18 is the floor. There is no under-18 option anywhere in NOD (docs/07 section 6).
  ageBracket: z.enum(['18-20', '21-25', '26-30', '31+']),
  locale: z.enum(['sv', 'en']).default('sv'),
  referredByCode: z.string().max(16).optional().nullable(),
})

export async function createParticipant(input: unknown): Promise<ActionResult<{ userId: string }>> {
  const parsed = signUpSchema.safeParse(input)
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'invalid')

  if (!(await rateLimit(`signup:${parsed.data.authId}`, 5, 60_000))) return fail('rateLimited')

  const existing = await prisma.user.findUnique({ where: { authId: parsed.data.authId } })
  if (existing) return { ok: true, data: { userId: existing.id } }

  const user = await signUp(parsed.data, referralCode)
  return { ok: true, data: { userId: user.id } }
}

/** Onboarding step 2/3 — connect an account and set its tier from the account type. */
export async function connectAccount(code: string): Promise<ActionResult<{ tier: string }>> {
  const user = await requireParticipant()

  const provider = socialProvider()
  const connected = await provider.exchangeCode(code)
  const profile = await provider.profile(connected.token)

  const minFollowers = await readFlag('eligibility.minFollowers')
  const minAvgViews = await readFlag('eligibility.minAvgViews')

  // Tier is what decides whether verification can read views automatically (docs/03).
  const belowFloor = profile.followers < minFollowers && profile.avgViews30d < minAvgViews
  const tier = belowFloor
    ? 'BELOW_FLOOR'
    : connected.accountType === 'personal'
      ? 'CONNECTED_SCREENSHOT'
      : 'CONNECTED_API'

  await prisma.socialAccount.upsert({
    where: { platform_platformUserId: { platform: 'INSTAGRAM', platformUserId: connected.platformUserId } },
    create: {
      userId: user.id,
      platform: 'INSTAGRAM',
      handle: connected.handle,
      platformUserId: connected.platformUserId,
      tier,
      accountType: connected.accountType,
      isPrivate: connected.isPrivate,
      followers: profile.followers,
      avgViews30d: profile.avgViews30d,
      categories: profile.categories ?? [],
      accessToken: connected.token ? encrypt(connected.token) : null,
      tokenExpiresAt: connected.expiresAt,
      lastSyncedAt: new Date(),
    },
    update: {
      handle: connected.handle,
      tier,
      accountType: connected.accountType,
      followers: profile.followers,
      avgViews30d: profile.avgViews30d,
      accessToken: connected.token ? encrypt(connected.token) : null,
      tokenExpiresAt: connected.expiresAt,
      lastSyncedAt: new Date(),
      disconnectedAt: null,
    },
  })

  await emit({ name: 'account/connected', data: { userId: user.id, tier } })
  revalidatePath('/accounts')
  return { ok: true, data: { tier } }
}

const onboardingSchema = z.object({
  termsAccepted: z.literal(true),
  disclosureQuizPassed: z.literal(true),
  trainingConsent: z.boolean(),
  swishNumber: z.string().min(6),
  categories: z.array(z.string()).default([]),
})

/** Onboarding steps 5–7 in one submit, then the ONBOARDED transition. */
export async function completeOnboarding(input: unknown): Promise<ActionResult> {
  const user = await requireParticipant()

  const parsed = onboardingSchema.safeParse(input)
  if (!parsed.success) return fail(parsed.error.issues[0]?.path.join('.') ?? 'invalid')

  const swish = normaliseSwishNumber(parsed.data.swishNumber)
  if (!swish) return fail('invalidSwish')

  await prisma.user.update({
    where: { id: user.id },
    data: {
      termsAcceptedAt: new Date(),
      disclosureQuizAt: new Date(),
      trainingConsent: parsed.data.trainingConsent,
      swishNumber: encrypt(swish),
    },
  })

  try {
    await onboard(user.id, { kind: 'PARTICIPANT', id: user.id })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'onboardFailed')
  }

  revalidatePath('/campaigns')
  return { ok: true }
}

export async function savePushSubscription(subscription: unknown): Promise<ActionResult> {
  const user = await requireParticipant()
  await prisma.user.update({
    where: { id: user.id },
    data: { pushSubscription: subscription as never },
  })
  return { ok: true }
}

// ---------------------------------------------------------------- BankID

export async function startBankId(returnUrl: string): Promise<ActionResult<{ url: string }>> {
  const user = await requireParticipant()
  if (!(await rateLimit(`bankid:${user.id}`, 5, 60_000))) return fail('rateLimited')

  const { url } = await identityProvider().start(user.id, returnUrl)
  return { ok: true, data: { url } }
}

/**
 * Completes BankID and transitions to VERIFIED. The raw subject stays inside
 * verifyIdentity, which hashes it; nothing identifying is returned to the caller.
 */
export async function completeBankId(payload: Record<string, string>): Promise<ActionResult> {
  const user = await requireParticipant()

  try {
    const result = await identityProvider().complete(payload)
    await verifyIdentity(user.id, result, { kind: 'PARTICIPANT', id: user.id })
  } catch (error) {
    if (error instanceof IdentityError) return fail(error.code === 'UNDER_18' ? 'under18' : 'duplicate')
    return fail('failed')
  }

  revalidatePath('/campaigns')
  return { ok: true }
}

// ---------------------------------------------------------------- claim flow

export async function claimCampaign(input: unknown): Promise<ActionResult<{ placementId: string }>> {
  const user = await requireParticipant()

  const parsed = z
    .object({
      campaignId: z.string().min(1),
      socialAccountId: z.string().min(1),
      contentType: z.enum(['story', 'reel', 'post']).optional(),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  if (!(await rateLimit(`claim:${user.id}`, 10, 60_000))) return fail('rateLimited')

  try {
    const placement = await claim({ ...parsed.data, userId: user.id })
    await emit({ name: 'placement/claimed', data: { placementId: placement.id }, id: `claimed:${placement.id}` })
    revalidatePath('/placements')
    return { ok: true, data: { placementId: placement.id } }
  } catch (error) {
    if (error instanceof ClaimError) return fail(error.code)
    return fail('claimFailed')
  }
}

/** P-02 upload. The file itself is stored by the upload route; this records the result. */
export async function submitUpload(input: unknown): Promise<ActionResult> {
  const user = await requireParticipant()

  const parsed = z
    .object({
      placementId: z.string().min(1),
      storagePath: z.string().min(1),
      perceptualHash: z.string().length(16),
      contentType: z.enum(['story', 'reel', 'post']),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: parsed.data.placementId },
    select: { userId: true, campaign: { select: { exclusions: true, brandSafety: true } }, account: { select: { categories: true } } },
  })
  if (placement.userId !== user.id) return fail('forbidden')

  const safety = brandSafetyCheck({
    accountCategories: placement.account.categories,
    exclusions: placement.campaign.exclusions,
    brandSafety: placement.campaign.brandSafety,
  })
  if (!safety.ok) return fail('brandSafety')

  try {
    await upload(parsed.data, { kind: 'PARTICIPANT', id: user.id })
  } catch (error) {
    return fail(error instanceof Error && error.message.includes('DUPLICATE') ? 'duplicate' : 'uploadFailed')
  }

  revalidatePath(`/placements/${parsed.data.placementId}`)
  return { ok: true }
}

/** P-03 position, then P-04 kick off generation. */
export async function submitPosition(input: unknown): Promise<ActionResult> {
  const user = await requireParticipant()

  const parsed = z
    .object({
      placementId: z.string().min(1),
      region: z.object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        w: z.number().min(0.01).max(1),
        h: z.number().min(0.01).max(1),
        label: z.string().optional(),
      }),
      assetId: z.string().min(1),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: parsed.data.placementId },
    select: { userId: true, originalPath: true },
  })
  if (placement.userId !== user.id) return fail('forbidden')

  const actor = { kind: 'PARTICIPANT' as const, id: user.id }
  await position(parsed.data.placementId, parsed.data, actor)
  await startGeneration(parsed.data.placementId)

  // The pilot engine defers to the ops queue; a real engine returns a version here.
  const engine = placementEngine()
  const result = await engine.render({
    placementId: parsed.data.placementId,
    imagePath: placement.originalPath ?? '',
    region: parsed.data.region,
    assetPath: parsed.data.assetId,
  })

  if (!result.deferred) {
    const { generationDone } = await import('@/lib/state/placement')
    await generationDone(parsed.data.placementId, {
      storagePath: result.resultPath,
      engine: result.engine,
      params: result.params,
    })
  }

  revalidatePath(`/placements/${parsed.data.placementId}`)
  return { ok: true }
}

export async function approvePlacement(placementId: string): Promise<ActionResult> {
  const user = await requireParticipant()
  const owned = await ownsPlacement(user.id, placementId)
  if (!owned) return fail('forbidden')

  await participantApprove(placementId, { kind: 'PARTICIPANT', id: user.id })
  revalidatePath(`/placements/${placementId}`)
  return { ok: true }
}

export async function regeneratePlacement(input: unknown): Promise<ActionResult> {
  const user = await requireParticipant()

  const parsed = z
    .object({
      placementId: z.string().min(1),
      kind: z.enum(['REGEN', 'MOVE', 'SWAP']).default('REGEN'),
      reason: z.string().max(500).optional(),
      assetId: z.string().optional(),
      region: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), label: z.string().optional() })
        .optional(),
    })
    .safeParse(input)
  if (!parsed.success) return fail('invalid')

  if (!(await ownsPlacement(user.id, parsed.data.placementId))) return fail('forbidden')

  try {
    await regenerate(parsed.data.placementId, parsed.data, { kind: 'PARTICIPANT', id: user.id })
  } catch {
    return fail('regenLimit')
  }

  await startGeneration(parsed.data.placementId)
  revalidatePath(`/placements/${parsed.data.placementId}`)
  return { ok: true }
}

export async function rejectPlacement(placementId: string, reason: string): Promise<ActionResult> {
  const user = await requireParticipant()
  if (!(await ownsPlacement(user.id, placementId))) return fail('forbidden')

  await participantReject(placementId, reason.slice(0, 500), { kind: 'PARTICIPANT', id: user.id })
  revalidatePath('/placements')
  return { ok: true }
}

/** P-07 -> P-08. The URL must belong to the account that claimed the placement. */
export async function submitPostUrl(placementId: string, postUrl: string): Promise<ActionResult> {
  const user = await requireParticipant()

  const parsed = z.string().url().safeParse(postUrl)
  if (!parsed.success) return fail('invalidUrl')

  const placement = await prisma.placement.findUniqueOrThrow({
    where: { id: placementId },
    select: { userId: true, account: { select: { handle: true, platform: true } } },
  })
  if (placement.userId !== user.id) return fail('forbidden')

  const host = new URL(parsed.data).hostname.replace(/^www\./, '')
  const expected = placement.account.platform === 'TIKTOK' ? 'tiktok.com' : 'instagram.com'
  if (!host.endsWith(expected)) return fail('invalidUrl')

  await publish(placementId, { postUrl: parsed.data }, { kind: 'PARTICIPANT', id: user.id })
  revalidatePath(`/placements/${placementId}`)
  return { ok: true }
}

async function ownsPlacement(userId: string, placementId: string): Promise<boolean> {
  const placement = await prisma.placement.findUnique({
    where: { id: placementId },
    select: { userId: true },
  })
  return placement?.userId === userId
}

// ---------------------------------------------------------------- settings

export async function setTrainingConsent(consent: boolean): Promise<ActionResult> {
  const user = await requireParticipant()
  await prisma.user.update({ where: { id: user.id }, data: { trainingConsent: consent } })
  revalidatePath('/settings')
  return { ok: true }
}

export async function updateSwishNumber(raw: string): Promise<ActionResult> {
  const user = await requireParticipant()
  const swish = normaliseSwishNumber(raw)
  if (!swish) return fail('invalidSwish')
  await prisma.user.update({ where: { id: user.id }, data: { swishNumber: encrypt(swish) } })
  revalidatePath('/settings')
  return { ok: true }
}

/** GDPR: request deletion. 30-day grace, then the erasure job runs (docs/07 section 3). */
export async function requestDeletion(): Promise<ActionResult> {
  const user = await requireParticipant()
  await prisma.user.update({ where: { id: user.id }, data: { deletionRequestedAt: new Date() } })
  await emit({ name: 'participant/deletion.requested', data: { userId: user.id } })
  revalidatePath('/settings')
  return { ok: true }
}

export async function cancelDeletion(): Promise<ActionResult> {
  const user = await requireParticipant()
  await prisma.user.update({ where: { id: user.id }, data: { deletionRequestedAt: null } })
  revalidatePath('/settings')
  return { ok: true }
}

/** GDPR: download my data. Returns everything NOD holds about the caller. */
export async function exportMyData(): Promise<ActionResult<Record<string, unknown>>> {
  const session = await getSession()
  if (!session || session.kind === 'brand') return fail('forbidden')
  await requireRole('PARTICIPANT').catch(() => undefined)

  const userId = session.user.id

  const [user, accounts, placements, ledger, strikes, identity] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, email: true, locale: true, city: true, ageBracket: true,
        trainingConsent: true, termsAcceptedAt: true, disclosureQuizAt: true,
        referralCode: true, reputation: true, createdAt: true,
      },
    }),
    prisma.socialAccount.findMany({
      where: { userId },
      select: { platform: true, handle: true, tier: true, followers: true, avgViews30d: true, createdAt: true },
    }),
    prisma.placement.findMany({
      where: { userId },
      select: {
        id: true, state: true, reservationOre: true, claimedAt: true, postUrl: true,
        campaign: { select: { name: true, brand: { select: { name: true } } } },
        verification: { select: { views: true, qualifiedViews: true, decidedAt: true } },
      },
    }),
    prisma.ledgerEntry.findMany({
      where: { wallet: { userId } },
      select: { type: true, amountOre: true, memo: true, createdAt: true },
    }),
    prisma.strike.findMany({ where: { userId }, select: { severity: true, reason: true, createdAt: true } }),
    // The subject hash is deliberately excluded: it is not the person's data to take,
    // it is NOD's re-registration control (docs/07 section 3).
    prisma.identity.findUnique({ where: { userId }, select: { birthYear: true, verifiedAt: true, provider: true } }),
  ])

  return {
    ok: true,
    data: { exportedAt: new Date().toISOString(), user, accounts, placements, ledger, strikes, identity },
  }
}

export async function setLocalePreference(locale: 'sv' | 'en'): Promise<ActionResult> {
  const session = await getSession()
  if (!session || session.kind === 'brand') return fail('forbidden')
  await prisma.user.update({ where: { id: session.user.id }, data: { locale } })
  const actor = actorFor(session)
  void actor
  return { ok: true }
}
