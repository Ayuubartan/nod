/**
 * Integration-test harness. Runs against the `nod_test` database in docker-compose,
 * truncating between tests so each one starts from a known empty state.
 *
 * tests/setup.ts points DATABASE_URL at nod_test before this module loads, so `db` here
 * is the very same client the code under test uses — not a second connection.
 */

import { prisma } from '@/lib/db'
import { encrypt, hashSubject, referralCode } from '@/lib/crypto'
import { DEFAULTS, sek } from '@/lib/money/rates'
import { invalidateFlagCache } from '@/lib/flags'
import { clearCapturedEvents } from '@/lib/events'
import { clearSentMail } from '@/lib/email'
import { clearOpsAlerts, clearSentPushes } from '@/lib/notify'
import { resetRateLimits } from '@/lib/rate-limit'

export const db = prisma

/** Tables truncated between tests, children first. */
const TABLES = [
  'LedgerEntry', 'ViewSnapshot', 'Verification', 'Dispute', 'PlacementEvent',
  'PlacementVersion', 'Placement', 'CampaignAsset', 'PayoutTemplate', 'Campaign',
  'BrandUser', 'Brand', 'PayoutBatch', 'Wallet', 'Strike', 'Referral', 'Identity',
  'SocialAccount', 'User', 'AuditLog', 'Flag', 'WaitlistEntry', 'BrandEnquiry',
  'IdempotencyKey',
]

export async function resetDb(): Promise<void> {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  )
  invalidateFlagCache()
  clearCapturedEvents()
  clearSentMail()
  clearSentPushes()
  clearOpsAlerts()
  resetRateLimits()
}

// ---------------------------------------------------------------- factories

let counter = 0
const uid = () => `t${++counter}_${Date.now().toString(36)}`

export async function makeBrand(name = 'Kaffeklubben') {
  const brand = await db.brand.create({ data: { name } })
  await db.brandUser.create({
    data: { brandId: brand.id, authId: uid(), email: `brand-${brand.id}@example.se`, role: 'admin' },
  })
  return brand
}

export type MakeCampaignArgs = {
  brandId: string
  state?: 'DRAFT' | 'AWAITING_FUNDS' | 'FUNDED' | 'LIVE' | 'FILLING'
  budgetOre?: number
  fundOre?: number
  reviewTier?: 'A' | 'B'
  perPersonCap?: number
  perPlacementMaxOre?: number
  cities?: string[]
  ageBrackets?: string[]
  minFollowers?: number
  categories?: string[]
  fixedOre?: number
  cpmOre?: number
  viewFloor?: number
  endsAt?: Date
}

export async function makeCampaign(args: MakeCampaignArgs) {
  const budget = args.budgetOre ?? sek(50_000)

  const campaign = await db.campaign.create({
    data: {
      brandId: args.brandId,
      name: 'Test campaign',
      state: args.state ?? 'LIVE',
      budget,
      perPlacementMax: args.perPlacementMaxOre ?? DEFAULTS.perPlacementMaxOre,
      perPersonCap: args.perPersonCap ?? DEFAULTS.perPersonCap,
      reviewTier: args.reviewTier ?? 'B',
      cities: args.cities ?? [],
      ageBrackets: args.ageBrackets ?? [],
      minFollowers: args.minFollowers ?? 300,
      categories: args.categories ?? [],
      disclosureText: 'Reklam – i samarbete med {brand}',
      endsAt: args.endsAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      goLiveAt: new Date(Date.now() - 1000),
      fundedAt: new Date(),
      fundedVia: 'card',
    },
  })

  await db.payoutTemplate.create({
    data: {
      campaignId: campaign.id,
      kind: 'HYBRID',
      fixedOre: args.fixedOre ?? DEFAULTS.fixedOre,
      cpmOre: args.cpmOre ?? DEFAULTS.cpmOre,
      viewFloor: args.viewFloor ?? DEFAULTS.viewFloor,
      takeRateBps: DEFAULTS.takeRateBps,
    },
  })

  await db.campaignAsset.create({
    data: { campaignId: campaign.id, name: 'Product', storagePath: 'test/asset.png', placementTypes: ['product'] },
  })

  // The deposit is what makes budget available.
  const fundOre = args.fundOre ?? budget
  if (fundOre > 0) {
    await db.ledgerEntry.create({
      data: { type: 'DEPOSIT', amountOre: fundOre, campaignId: campaign.id, memo: 'Test deposit' },
    })
  }

  return db.campaign.findUniqueOrThrow({
    where: { id: campaign.id },
    include: { payoutTemplate: true, assets: true },
  })
}

export type MakeParticipantArgs = {
  state?: 'SIGNED_UP' | 'ONBOARDED' | 'VERIFIED' | 'ACTIVE' | 'FLAGGED' | 'SUSPENDED'
  avgViews30d?: number
  followers?: number
  tier?: 'CONNECTED_API' | 'CONNECTED_SCREENSHOT' | 'BELOW_FLOOR' | 'DISCONNECTED'
  city?: string
  ageBracket?: string
  categories?: string[]
  withIdentity?: boolean
  swishNumber?: string | null
}

export async function makeParticipant(args: MakeParticipantArgs = {}) {
  const followers = args.followers ?? 820
  const state = args.state ?? 'VERIFIED'

  const user = await db.user.create({
    data: {
      authId: uid(),
      email: `p-${uid()}@example.se`,
      state,
      locale: 'sv',
      city: args.city ?? 'stockholm',
      ageBracket: args.ageBracket ?? '21-25',
      referralCode: referralCode() + counter,
      swishNumber: args.swishNumber === null ? null : encrypt(args.swishNumber ?? '+46701234567'),
      termsAcceptedAt: new Date(),
      disclosureQuizAt: new Date(),
    },
  })

  await db.wallet.create({ data: { userId: user.id } })

  if (args.withIdentity !== false && ['VERIFIED', 'ACTIVE', 'FLAGGED', 'SUSPENDED'].includes(state)) {
    await db.identity.create({
      data: {
        userId: user.id,
        subjectHash: hashSubject(`subject-${user.id}`),
        birthYear: 2001,
        verifiedAt: new Date(),
        provider: 'fake:se-bankid',
      },
    })
  }

  const account = await db.socialAccount.create({
    data: {
      userId: user.id,
      platform: 'INSTAGRAM',
      handle: `user_${counter}`,
      platformUserId: `ig_${uid()}`,
      tier: args.tier ?? 'CONNECTED_API',
      accountType: 'creator',
      followers,
      avgViews30d: args.avgViews30d ?? Math.round(followers * 0.55),
      categories: args.categories ?? [],
      accessToken: encrypt('test-token'),
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    },
  })

  return { user, account }
}

export async function ledgerFor(campaignId: string) {
  return db.ledgerEntry.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } })
}

export async function auditFor(entity: string, entityId: string) {
  return db.auditLog.findMany({ where: { entity, entityId }, orderBy: { createdAt: 'asc' } })
}
