import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { flags } from '@/lib/flags'
import { levelFor, nextLevel, rankOf, weeklyLeaderboard, weeklyStanding } from '@/lib/queue'
import { readQueueCookie } from '@/lib/queue-session'
import { QueueStatus, type QueueView } from '@/components/marketing/QueueStatus'
import { QueueLinkForm } from '@/components/marketing/QueueLinkForm'

/**
 * Page two of the game (docs/13): where you are, what moves you, who to invite.
 *
 * Identity is the NOD_QUEUE cookie, or a signed token in ?t= from a mail or SMS.
 * A page cannot write cookies, so a token is handed to /queue/open, which sets the
 * cookie, proves the address when the token came by mail, and comes back here
 * without it — the token never sits in the address bar or a screenshot.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('queue')
  return { title: t('metaTitle') }
}

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ t?: string; joined?: string }> }) {
  const { t: token, joined } = await searchParams
  if (token) redirect(`/queue/open?t=${encodeURIComponent(token)}`)

  const entryId = await readQueueCookie()
  const entry = entryId ? await prisma.waitlistEntry.findFirst({ where: { id: entryId, deletedAt: null } }) : null
  if (!entry) return <QueueLinkForm />

  const [rank, cityRank, standing, board, settings, recent] = await Promise.all([
    rankOf(entry),
    rankOf(entry, entry.city),
    weeklyStanding(entry),
    weeklyLeaderboard(entry.city, 10),
    flags('waitlist.smsEnabled', 'waitlist.gate'),
    prisma.waitlistEvent.findMany({
      where: { entryId: entry.id, type: { notIn: ['SIGNED_UP', 'ACCESS_USED'] } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, type: true, data: true, createdAt: true },
    }),
  ])

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const level = levelFor(entry.verifiedReferrals)
  const next = nextLevel(entry.verifiedReferrals)
  const now = Date.now()
  const accessOpen =
    Boolean(entry.accessGrantedAt) && (!entry.accessExpiresAt || entry.accessExpiresAt.getTime() > now)

  const view: QueueView = {
    email: entry.email,
    city: entry.city,
    position: entry.position,
    points: entry.points,
    rank,
    cityRank,
    level: { level: level.level, key: level.key },
    next: next ? { key: next.level.key, referrals: next.level.referrals, remaining: next.remaining, priority: next.level.priority } : null,
    verifiedReferrals: entry.verifiedReferrals,
    shareUrl: `${siteUrl}/r/${entry.referralCode}`,
    referralCode: entry.referralCode,
    emailVerified: Boolean(entry.emailVerifiedAt),
    phone: entry.phone,
    phoneVerified: Boolean(entry.phoneVerifiedAt),
    phoneVerificationAvailable: settings['waitlist.smsEnabled'] || process.env.NODE_ENV !== 'production',
    profile: {
      displayName: entry.displayName ?? '',
      handle: entry.handle ?? '',
      ageBracket: entry.ageBracket ?? '',
      followersBracket: entry.followersBracket ?? '',
      categories: entry.categories,
      complete: Boolean(entry.ageBracket && entry.followersBracket && entry.handle),
    },
    smsOn: Boolean(entry.smsConsentAt && !entry.smsOptOutAt),
    week: { points: standing.points, rank: standing.rank },
    leaderboard: board.map((row) => ({ ...row, me: row.entryId === entry.id })),
    events: recent.map((e) => ({ id: e.id, type: e.type, data: (e.data ?? {}) as Record<string, unknown>, at: e.createdAt.toISOString() })),
    access: accessOpen
      ? { until: entry.accessExpiresAt?.toISOString() ?? null }
      : settings['waitlist.gate']
        ? null
        : { until: null },
    gate: settings['waitlist.gate'],
    converted: Boolean(entry.convertedUserId),
  }

  return <QueueStatus view={view} justJoined={joined === '1'} />
}
