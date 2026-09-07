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

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { loadEnv } from '../lib/env'

loadEnv()
import { encrypt, hashSubject, referralCode } from '../lib/crypto'
import { DEFAULTS, sek } from '../lib/money/rates'
import { FLAG_DEFAULTS } from '../lib/flags'
import { BAG_PALETTES, demoDesk, demoKitchen, productBag, productLogo } from '../lib/demo-art'

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

  // ---- demo photos a participant can upload in the walkthrough
  await store('demo/kitchen.jpg', await demoKitchen(), 'image/jpeg')
  await store('demo/desk.jpg', await demoDesk(), 'image/jpeg')
  console.info('  demo photos: demo/kitchen.jpg, demo/desk.jpg')

  await seedPlacements()
  console.info('Seed complete.')
}

/**
 * Writes a file to whichever storage backend the environment points at (Supabase,
 * Vercel Blob, or .storage/), so a seed run against a hosted database also puts the
 * images where that deploy will read them. lib/storage is server-only; without
 * `--conditions=react-server` the import throws and we mirror its local fallback.
 */
async function store(path: string, body: Buffer, contentType: string): Promise<void> {
  const put = await storagePut()
  if (put) {
    await put(path, body, contentType)
    return
  }
  const file = join(process.cwd(), '.storage', path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, body)
}

let storagePutPromise: Promise<typeof import('../lib/storage')['put'] | null> | undefined
function storagePut() {
  storagePutPromise ??= import('../lib/storage').then(
    (m) => {
      console.info(`  storage backend: ${m.backend()}`)
      return m.put
    },
    () => null,
  )
  return storagePutPromise
}

/**
 * A few placements on the live campaign, driven through the real state machine so the
 * ledger, audit log and events are all consistent: one waiting on the participant, one
 * waiting on the brand, one published, one qualified and paid.
 *
 * Needs the engine + storage modules, which are marked server-only; run the seed with
 * `--conditions=react-server` (package.json does) so that import is a no-op.
 */
async function seedPlacements(): Promise<void> {
  const existing = await prisma.placement.count({ where: { campaignId: 'seed-campaign-live' } })
  if (existing > 0) return

  let render: typeof import('../lib/render')
  let placementState: typeof import('../lib/state/placement')
  let verification: typeof import('../lib/state/verification')
  try {
    ;[render, placementState, verification] = await Promise.all([
      import('../lib/render'),
      import('../lib/state/placement'),
      import('../lib/state/verification'),
    ])
  } catch (error) {
    console.warn('  placements: skipped (run with --conditions=react-server to seed them)', error)
    return
  }

  const { claim, upload, position, participantApprove, brandApprove, publish, holdEnded, markPaid } = placementState
  const photo = await demoKitchen()
  const asset = await prisma.campaignAsset.findUniqueOrThrow({ where: { id: 'seed-asset-bag-seed-campaign-live' } })
  const brandUser = await prisma.brandUser.findUniqueOrThrow({ where: { authId: 'seed-brand-user' } })
  const brandActor = { kind: 'BRAND' as const, id: brandUser.id }

  const regions = [
    { x: 0.08, y: 0.62, w: 0.4, h: 0.3, label: 'lower-third' },
    { x: 0.58, y: 0.24, w: 0.34, h: 0.34, label: 'right-third' },
    { x: 0.34, y: 0.36, w: 0.32, h: 0.28, label: 'centre' },
    { x: 0.55, y: 0.6, w: 0.36, h: 0.32, label: 'custom' },
  ]

  const plan = [
    { authId: 'seed-p1', until: 'PARTICIPANT_REVIEW' },
    { authId: 'seed-p3', until: 'BRAND_REVIEW' },
    { authId: 'seed-p2', until: 'PUBLISHED' },
    { authId: 'seed-p1', until: 'PAID' },
  ] as const

  let made = 0
  for (const [index, step] of plan.entries()) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { authId: step.authId },
      include: { accounts: { take: 1 } },
    })
    const account = user.accounts[0]
    if (!account) continue
    const actor = { kind: 'PARTICIPANT' as const, id: user.id }

    const { id } = await claim({ campaignId: 'seed-campaign-live', userId: user.id, socialAccountId: account.id, contentType: 'post' })

    const originalPath = `originals/${id}.jpg`
    await store(originalPath, photo, 'image/jpeg')
    await upload({ placementId: id, storagePath: originalPath, perceptualHash: `seed${index}`.padEnd(16, '0'), contentType: 'post' }, actor)
    await position(id, { region: regions[index]!, assetId: asset.id, candidates: regions.slice(0, 3) }, actor)
    const outcome = await render.generate(id, actor)
    made += 1
    if (outcome !== 'rendered' || step.until === 'PARTICIPANT_REVIEW') continue

    await participantApprove(id, actor, { sampleRoll: 0 })
    if (step.until === 'BRAND_REVIEW') continue

    await brandApprove(id, brandActor)
    const postUrl = `https://www.instagram.com/p/seed${index}/`
    await publish(id, { postUrl }, actor, new Date(Date.now() - 4 * 24 * 60 * 60 * 1000))
    if (step.until === 'PUBLISHED') continue

    await holdEnded(id)
    await verification.verify({
      placementId: id,
      observedPlatformUserId: account.platformUserId,
      caption: 'Morgonkaffe. Reklam – i samarbete med Kaffeklubben',
      hasPaidPartnershipLabel: true,
      publishedHash: null,
      views: 3_200,
      viewsSource: 'api',
      engagements: 210,
      geoMatch: 0.92,
    })
    await markPaid(id)
  }
  console.info(`  placements: ${made}`)
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

  // Real files under .storage/ so the position step, the composite engine and the brand
  // dashboard all have something to show. Ids are deterministic so re-seeding is a no-op.
  const assets = [
    { id: `seed-asset-bag-${args.id}`, name: 'Kaffepåse 500g', types: ['product', 'packaging'], art: () => productBag(BAG_PALETTES.autumn) },
    { id: `seed-asset-winter-${args.id}`, name: 'Kaffepåse — vinter', types: ['product', 'packaging'], art: () => productBag(BAG_PALETTES.winter) },
    { id: `seed-asset-logo-${args.id}`, name: 'Logotyp', types: ['logo'], art: () => productLogo() },
  ]
  for (const asset of assets) {
    const storagePath = `assets/${args.id}/${asset.id}.png`
    await store(storagePath, await asset.art(), 'image/png')
    await prisma.campaignAsset.upsert({
      where: { id: asset.id },
      create: { id: asset.id, campaignId: campaign.id, name: asset.name, storagePath, placementTypes: asset.types },
      update: { storagePath, deletedAt: null },
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
