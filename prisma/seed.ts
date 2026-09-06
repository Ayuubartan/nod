/**
 * Seed — gives every milestone data to work with (CLAUDE.md "Definition of done").
 *
 * Creates: flags, an ops user, a brand with a user, one FUNDED campaign ready to go
 * live and one LIVE campaign, and a handful of participants across every state and
 * account tier so the marketplace, the ops queues and the eligibility rules all have
 * something to show.
 *
 * Idempotent: safe to run repeatedly against the same database.
 */

import { PrismaClient } from '@prisma/client'
import { loadEnv } from '../lib/env'

loadEnv()
import { encrypt, hashSubject, referralCode } from '../lib/crypto'
import { DEFAULTS, sek } from '../lib/money/rates'
import { FLAG_DEFAULTS } from '../lib/flags'

const prisma = new PrismaClient()

const CITY = 'stockholm'

async function main() {
  console.info('Seeding NOD…')

  // ---- flags
  for (const [key, value] of Object.entries(FLAG_DEFAULTS)) {
    await prisma.flag.upsert({
      where: { key },
      create: { key, value: value as never },
      update: {},
    })
  }
  console.info(`  flags: ${Object.keys(FLAG_DEFAULTS).length}`)

  // ---- ops user
  await prisma.user.upsert({
    where: { authId: 'seed-ops' },
    create: {
      authId: 'seed-ops',
      email: 'ops@nod.se',
      role: 'OPS',
      state: 'ACTIVE',
      locale: 'sv',
      city: CITY,
      referralCode: 'OPS001',
    },
    update: {},
  })

  // ---- brand
  const brand = await prisma.brand.upsert({
    where: { id: 'seed-brand' },
    create: {
      id: 'seed-brand',
      name: 'Kaffeklubben',
      orgNumber: '556000-0000',
      rolloverPreference: 'refund',
    },
    update: {},
  })

  await prisma.brandUser.upsert({
    where: { authId: 'seed-brand-user' },
    create: {
      authId: 'seed-brand-user',
      brandId: brand.id,
      email: 'brand@example.se',
      name: 'Brand Admin',
      role: 'admin',
    },
    update: {},
  })

  // ---- participants across every interesting state
  const people = [
    { authId: 'seed-p1', handle: 'anna_sthlm', followers: 820, tier: 'CONNECTED_API', state: 'ACTIVE', age: '21-25' },
    { authId: 'seed-p2', handle: 'jonas_gym', followers: 1_540, tier: 'CONNECTED_API', state: 'VERIFIED', age: '21-25' },
    { authId: 'seed-p3', handle: 'lina_food', followers: 4_900, tier: 'CONNECTED_SCREENSHOT', state: 'ACTIVE', age: '26-30' },
    { authId: 'seed-p4', handle: 'omar_new', followers: 180, tier: 'BELOW_FLOOR', state: 'ONBOARDED', age: '18-20' },
    { authId: 'seed-p5', handle: 'sara_flagged', followers: 2_100, tier: 'CONNECTED_API', state: 'FLAGGED', age: '21-25' },
  ] as const

  const userIds: string[] = []

  for (const [index, person] of people.entries()) {
    const user = await prisma.user.upsert({
      where: { authId: person.authId },
      create: {
        authId: person.authId,
        email: `${person.handle}@example.se`,
        role: 'PARTICIPANT',
        state: person.state,
        locale: index % 2 === 0 ? 'sv' : 'en',
        city: CITY,
        ageBracket: person.age,
        swishNumber: encrypt('+46701234567'),
        trainingConsent: index % 2 === 0,
        disclosureQuizAt: new Date(),
        termsAcceptedAt: new Date(),
        referralCode: referralCode(),
        onboardingStep: 9,
      },
      update: {},
      select: { id: true },
    })
    userIds.push(user.id)

    await prisma.wallet.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} })

    // Verified participants have a BankID identity; onboarded ones do not yet.
    if (person.state !== 'ONBOARDED') {
      await prisma.identity.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          subjectHash: hashSubject(`seed-subject-${person.authId}`),
          birthYear: 2001,
          verifiedAt: new Date(),
          provider: 'fake:se-bankid',
        },
        update: {},
      })
    }

    await prisma.socialAccount.upsert({
      where: { platform_platformUserId: { platform: 'INSTAGRAM', platformUserId: `seed_ig_${index}` } },
      create: {
        userId: user.id,
        platform: 'INSTAGRAM',
        handle: person.handle,
        platformUserId: `seed_ig_${index}`,
        tier: person.tier,
        accountType: person.tier === 'CONNECTED_API' ? 'creator' : 'personal',
        followers: person.followers,
        avgViews30d: Math.round(person.followers * 0.55),
        categories: ['food', 'gym'].slice(0, (index % 2) + 1),
        accessToken: encrypt(`seed-token-${index}`),
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        lastSyncedAt: new Date(),
      },
      update: {},
    })
  }
  console.info(`  participants: ${people.length}`)

  // ---- campaigns
  await seedCampaign({
    id: 'seed-campaign-live',
    brandId: brand.id,
    name: 'Kaffeklubben — hösten',
    state: 'LIVE',
    budgetOre: sek(50_000),
    fundNow: true,
    goLiveAt: new Date(Date.now() - 60 * 60 * 1000),
  })

  await seedCampaign({
    id: 'seed-campaign-funded',
    brandId: brand.id,
    name: 'Kaffeklubben — vinterdrop',
    state: 'FUNDED',
    budgetOre: sek(25_000),
    fundNow: true,
    goLiveAt: nextFriday(),
  })

  await seedCampaign({
    id: 'seed-campaign-draft',
    brandId: brand.id,
    name: 'Kaffeklubben — utkast',
    state: 'DRAFT',
    budgetOre: sek(10_000),
    fundNow: false,
    goLiveAt: nextFriday(),
  })

  console.info('  campaigns: 3')
  console.info('Seed complete.')
}

function nextFriday(): Date {
  const d = new Date()
  d.setHours(18, 0, 0, 0)
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7))
  return d
}

async function seedCampaign(args: {
  id: string
  brandId: string
  name: string
  state: 'DRAFT' | 'FUNDED' | 'LIVE'
  budgetOre: number
  fundNow: boolean
  goLiveAt: Date
}) {
  const campaign = await prisma.campaign.upsert({
    where: { id: args.id },
    create: {
      id: args.id,
      brandId: args.brandId,
      name: args.name,
      state: args.state,
      objective: 'awareness',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      goLiveAt: args.goLiveAt,
      cities: [CITY],
      ageBrackets: ['18-20', '21-25', '26-30'],
      minFollowers: 300,
      categories: [],
      rulesText: 'Produkten ska synas naturligt. Inga barn i bild. Ingen alkohol.',
      brandSafety: ['alcohol'],
      reviewTier: 'B',
      disclosureText: 'Reklam – i samarbete med {brand}',
      perPersonCap: DEFAULTS.perPersonCap,
      budget: args.budgetOre,
      perPlacementMax: DEFAULTS.perPlacementMaxOre,
      fundedVia: args.fundNow ? 'card' : null,
      fundedAt: args.fundNow ? new Date() : null,
      liveAt: args.state === 'LIVE' ? new Date() : null,
    },
    update: {},
    select: { id: true },
  })

  await prisma.payoutTemplate.upsert({
    where: { campaignId: campaign.id },
    create: {
      campaignId: campaign.id,
      kind: 'HYBRID',
      fixedOre: DEFAULTS.fixedOre,
      cpmOre: DEFAULTS.cpmOre,
      viewFloor: DEFAULTS.viewFloor,
      takeRateBps: DEFAULTS.takeRateBps,
    },
    update: {},
  })

  const assetCount = await prisma.campaignAsset.count({ where: { campaignId: campaign.id } })
  if (assetCount === 0) {
    await prisma.campaignAsset.createMany({
      data: [
        {
          campaignId: campaign.id,
          name: 'Kaffepåse 500g',
          storagePath: `seed/assets/${campaign.id}/bag.png`,
          placementTypes: ['product', 'packaging'],
        },
        {
          campaignId: campaign.id,
          name: 'Logotyp',
          storagePath: `seed/assets/${campaign.id}/logo.png`,
          placementTypes: ['logo'],
        },
      ],
    })
  }

  // The deposit is what makes budget available; without it no claim can reserve.
  if (args.fundNow) {
    const existing = await prisma.ledgerEntry.count({ where: { campaignId: campaign.id, type: 'DEPOSIT' } })
    if (existing === 0) {
      await prisma.ledgerEntry.create({
        data: {
          type: 'DEPOSIT',
          amountOre: args.budgetOre,
          campaignId: campaign.id,
          memo: 'Seed deposit',
          externalRef: `seed-deposit-${campaign.id}`,
        },
      })
    }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
