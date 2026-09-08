import { prisma } from './db'

/**
 * The numbers on the landing page (docs/10 stats row). Every one is a live count —
 * never a placeholder — and a stat that is still zero is simply not shown, because
 * "0 creators posting" is true but says nothing.
 */
export type LandingStats = { waiting: number; posting: number; reach: number }

const LIVE = ['PUBLISHED', 'VERIFYING', 'QUALIFIED', 'PAID'] as const

export async function landingStats(): Promise<LandingStats> {
  const [waiting, posting, reach] = await Promise.all([
    prisma.waitlistEntry.count({ where: { deletedAt: null } }),
    prisma.placement
      .findMany({ where: { state: { in: [...LIVE] }, deletedAt: null }, distinct: ['userId'], select: { userId: true } })
      .then((rows) => rows.length),
    prisma.verification.aggregate({ _sum: { views: true }, where: { deletedAt: null } }).then((r) => r._sum.views ?? 0),
  ])
  return { waiting, posting, reach }
}

/** "2.4M", "18k", "4 821" — short enough for a stats row, honest to two figures. */
export function compact(n: number, locale: 'sv' | 'en'): string {
  return new Intl.NumberFormat(locale === 'sv' ? 'sv-SE' : 'en-GB', {
    notation: n >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(n)
}
