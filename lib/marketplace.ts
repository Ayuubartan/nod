/**
 * Marketplace queries — docs/02 section A2.
 *
 * The eligibility rules here MUST agree with the guards in `claim()`, or a participant
 * sees "Eligible" and then gets an error. Both read the same campaign fields, and the
 * reasons returned here map onto the i18n keys under `campaigns.reasons`.
 */

import type { Campaign, PayoutTemplate, SocialAccount, User } from '@prisma/client'
import { prisma } from './db'
import { campaignBalances } from './money/balances'
import { estimateParticipantOre, reservationOre } from './money/calc'

export type EligibilityReason =
  | 'followers'
  | 'city'
  | 'age'
  | 'category'
  | 'cap'
  | 'budget'
  | 'notVerified'
  | 'accountTier'
  | 'state'

export type Eligibility =
  | { eligible: true; account: SocialAccount; estimateOre: number; reservationOre: number }
  | { eligible: false; reason: EligibilityReason; detail?: string }

export type CampaignWithTemplate = Campaign & { payoutTemplate: PayoutTemplate | null }

/**
 * Which of this participant's accounts, if any, can claim this campaign — and what they
 * would earn. Picks the account with the highest estimate, which is what the card shows.
 */
export function evaluateEligibility(args: {
  campaign: CampaignWithTemplate
  user: Pick<User, 'state' | 'city' | 'ageBracket'>
  accounts: SocialAccount[]
  availableOre: number
  existingPlacements: number
}): Eligibility {
  const { campaign, user, accounts, availableOre, existingPlacements } = args

  if (user.state === 'SIGNED_UP' || user.state === 'ONBOARDED') {
    return { eligible: false, reason: 'notVerified' }
  }
  if (user.state !== 'VERIFIED' && user.state !== 'ACTIVE') {
    return { eligible: false, reason: 'state' }
  }
  if (existingPlacements >= campaign.perPersonCap) {
    return { eligible: false, reason: 'cap' }
  }
  if (campaign.cities.length > 0 && (!user.city || !campaign.cities.includes(user.city))) {
    return { eligible: false, reason: 'city', detail: campaign.cities.join(', ') }
  }
  if (campaign.ageBrackets.length > 0 && (!user.ageBracket || !campaign.ageBrackets.includes(user.ageBracket))) {
    return { eligible: false, reason: 'age' }
  }

  const usable = accounts.filter((a) => a.tier === 'CONNECTED_API' || a.tier === 'CONNECTED_SCREENSHOT')
  if (usable.length === 0) {
    return { eligible: false, reason: 'accountTier' }
  }

  const byFollowers = usable.filter(
    (a) => a.followers >= campaign.minFollowers && (!campaign.maxFollowers || a.followers <= campaign.maxFollowers),
  )
  if (byFollowers.length === 0) {
    return { eligible: false, reason: 'followers', detail: String(campaign.minFollowers) }
  }

  const byCategory = byFollowers.filter((a) => {
    const matches = campaign.categories.length === 0 || campaign.categories.some((c) => a.categories.includes(c))
    const excluded = campaign.exclusions.some((c) => a.categories.includes(c))
    return matches && !excluded
  })
  if (byCategory.length === 0) {
    return { eligible: false, reason: 'category' }
  }

  if (!campaign.payoutTemplate) return { eligible: false, reason: 'state' }
  const template = campaign.payoutTemplate

  // Best account = the one that would earn the most.
  const ranked = byCategory
    .map((account) => ({
      account,
      estimateOre: estimateParticipantOre(template, account.avgViews30d),
      reservationOre: reservationOre(template, account, campaign.perPlacementMax),
    }))
    .sort((a, b) => b.estimateOre - a.estimateOre)

  const best = ranked[0]!

  // The budget check uses the same reservation the claim will take, so an "Eligible"
  // badge cannot be followed by a BUDGET failure.
  const affordable = ranked.find((r) => r.reservationOre <= availableOre)
  if (!affordable) {
    return { eligible: false, reason: 'budget' }
  }

  return {
    eligible: true,
    account: affordable.account,
    estimateOre: affordable === best ? best.estimateOre : affordable.estimateOre,
    reservationOre: affordable.reservationOre,
  }
}

export type MarketplaceTab = 'forYou' | 'highestPaying' | 'new' | 'endingSoon'

export type MarketplaceCard = {
  campaign: CampaignWithTemplate & { brand: { name: string } }
  eligibility: Eligibility
  remainingPercent: number
  endsAt: Date | null
}

/** The marketplace list for one participant, already filtered and sorted. */
export async function marketplaceFor(userId: string, tab: MarketplaceTab = 'forYou'): Promise<MarketplaceCard[]> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { state: true, city: true, ageBracket: true },
  })

  const accounts = await prisma.socialAccount.findMany({ where: { userId, deletedAt: null } })

  const campaigns = await prisma.campaign.findMany({
    where: { state: { in: ['LIVE', 'FILLING'] }, deletedAt: null },
    include: { payoutTemplate: true, brand: { select: { name: true } } },
    orderBy: { liveAt: 'desc' },
    take: 100,
  })

  if (campaigns.length === 0) return []

  const [balances, placementCounts] = await Promise.all([
    campaignBalances(prisma, campaigns.map((c) => c.id)),
    prisma.placement.groupBy({
      by: ['campaignId'],
      where: {
        userId,
        deletedAt: null,
        state: { notIn: ['EXPIRED', 'REJECTED_BY_PARTICIPANT'] },
      },
      _count: { _all: true },
    }),
  ])

  const counts = new Map(placementCounts.map((p) => [p.campaignId, p._count._all]))

  const cards: MarketplaceCard[] = campaigns.map((campaign) => {
    const balance = balances.get(campaign.id)
    const availableOre = balance?.availableOre ?? 0

    return {
      campaign,
      eligibility: evaluateEligibility({
        campaign,
        user,
        accounts,
        availableOre,
        existingPlacements: counts.get(campaign.id) ?? 0,
      }),
      remainingPercent:
        balance && balance.depositedOre > 0
          ? Math.max(0, Math.round((availableOre / balance.depositedOre) * 100))
          : 0,
      endsAt: campaign.endsAt,
    }
  })

  return sortForTab(cards, tab)
}

function sortForTab(cards: MarketplaceCard[], tab: MarketplaceTab): MarketplaceCard[] {
  const estimate = (c: MarketplaceCard) => (c.eligibility.eligible ? c.eligibility.estimateOre : -1)

  switch (tab) {
    case 'highestPaying':
      return [...cards].sort((a, b) => estimate(b) - estimate(a))
    case 'new':
      return [...cards].sort(
        (a, b) => (b.campaign.liveAt?.getTime() ?? 0) - (a.campaign.liveAt?.getTime() ?? 0),
      )
    case 'endingSoon':
      return [...cards].sort(
        (a, b) => (a.endsAt?.getTime() ?? Infinity) - (b.endsAt?.getTime() ?? Infinity),
      )
    case 'forYou':
    default:
      // Eligible first, then by what they'd earn.
      return [...cards].sort((a, b) => {
        if (a.eligibility.eligible !== b.eligibility.eligible) return a.eligibility.eligible ? -1 : 1
        return estimate(b) - estimate(a)
      })
  }
}

/** Next Friday 18:00, shown in the marketplace empty state (docs/02 A2). */
export function nextDropLabel(from: Date = new Date()): Date {
  const d = new Date(from)
  d.setHours(18, 0, 0, 0)
  const days = (5 - d.getDay() + 7) % 7
  d.setDate(d.getDate() + days)
  if (d <= from) d.setDate(d.getDate() + 7)
  return d
}
