/**
 * Social account analytics — docs/06 sections 1-2, docs/02 A6.
 *
 * Three jobs live here:
 *   - `freshToken`: hand out a usable access token, refreshing first when it is about
 *     to expire (TikTok tokens last 24h, so "about to expire" is a daily event).
 *   - `syncAccount`: pull followers / 30-day average views from the platform, update
 *     the account and append a `SocialAccountSnapshot` so the history is visible.
 *   - `accountAnalytics`: the history and the deltas the accounts page shows.
 *
 * Everything is read-only against the platform (CLAUDE.md rule 6) and aggregate-only
 * in what it stores (docs/07): counts, never posts, never audiences.
 */

import type { AccountPlatform, SocialAccount } from '@prisma/client'
import { prisma } from '@/lib/db'
import { encrypt, tryDecrypt } from '@/lib/crypto'
import { emit } from '@/lib/events'
import { providerFor } from '@/lib/integrations/social'
import type { SocialProfile } from '@/lib/integrations/types'
import { log } from '@/lib/logger'

/** Refresh when the token has less than this left. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000

/** A manual "sync now" from the participant is honoured at most this often. */
export const MANUAL_SYNC_COOLDOWN_MS = 60 * 60 * 1000

type TokenFields = Pick<SocialAccount, 'id' | 'platform' | 'accessToken' | 'refreshToken' | 'tokenExpiresAt'>

/**
 * The decrypted access token for an account, refreshed and persisted first when it is
 * within the margin of expiring. Returns null when there is no token or the refresh
 * fails — the caller decides whether that means "skip" or "disconnect".
 */
export async function freshToken(account: TokenFields): Promise<string | null> {
  const token = tryDecrypt(account.accessToken)
  if (!token) return null

  const expiresSoon = account.tokenExpiresAt != null && account.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS
  if (!expiresSoon) return token

  try {
    const next = await providerFor(account.platform).refresh(token, tryDecrypt(account.refreshToken))
    await prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        accessToken: encrypt(next.token),
        refreshToken: next.refreshToken ? encrypt(next.refreshToken) : account.refreshToken,
        tokenExpiresAt: next.expiresAt,
      },
    })
    return next.token
  } catch (error) {
    log.warn('social token refresh failed', { accountId: account.id, platform: account.platform, error: String(error) })
    await emit({ name: 'account/token.refresh.failed', data: { accountId: account.id, platform: account.platform } })
    return null
  }
}

export type SyncResult =
  | { ok: true; followers: number; avgViews30d: number }
  | { ok: false; reason: 'no-token' | 'api-error' }

/**
 * Pull the account's current numbers and record a snapshot. An API failure does not
 * change the tier here — the token-refresh job owns DISCONNECTED — it just leaves the
 * last good numbers in place and reports the miss.
 */
export async function syncAccount(accountId: string): Promise<SyncResult> {
  const account = await prisma.socialAccount.findUniqueOrThrow({ where: { id: accountId } })
  if (account.deletedAt || account.tier === 'DISCONNECTED') return { ok: false, reason: 'no-token' }

  const token = await freshToken(account)
  if (!token) return { ok: false, reason: 'no-token' }

  const provider = providerFor(account.platform)
  let profile: SocialProfile
  let posts30d = 0
  try {
    profile = await provider.profile(token)
    posts30d = (await provider.recentMedia(token, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))).length
  } catch (error) {
    log.warn('social sync failed', { accountId, platform: account.platform, error: String(error) })
    return { ok: false, reason: 'api-error' }
  }

  await recordSnapshot(accountId, profile, posts30d)
  return { ok: true, followers: profile.followers, avgViews30d: profile.avgViews30d }
}

/** Write the numbers to the account and append the history row, in one transaction. */
export async function recordSnapshot(accountId: string, profile: SocialProfile, posts30d = 0): Promise<void> {
  await prisma.$transaction([
    prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        followers: profile.followers,
        avgViews30d: profile.avgViews30d,
        ...(profile.categories && profile.categories.length > 0 ? { categories: profile.categories } : {}),
        lastSyncedAt: new Date(),
      },
    }),
    prisma.socialAccountSnapshot.create({
      data: { accountId, followers: profile.followers, avgViews30d: profile.avgViews30d, posts30d },
    }),
  ])
}

export type AccountAnalytics = {
  accountId: string
  platform: AccountPlatform
  followers: number
  avgViews30d: number
  posts30d: number | null
  lastSyncedAt: Date | null
  /** Change in followers vs the oldest snapshot within the window; null with <2 points. */
  followersDelta30d: number | null
  avgViewsDelta30d: number | null
  /** Oldest → newest, for a sparkline. */
  history: Array<{ at: Date; followers: number; avgViews30d: number }>
}

/** Analytics for every live account a participant has, newest snapshot first inside. */
export async function accountAnalytics(userId: string, windowDays = 30): Promise<AccountAnalytics[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  const accounts = await prisma.socialAccount.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: {
      snapshots: {
        where: { deletedAt: null, capturedAt: { gte: since } },
        orderBy: { capturedAt: 'asc' },
        select: { capturedAt: true, followers: true, avgViews30d: true, posts30d: true },
      },
    },
  })

  return accounts.map((account) => {
    const first = account.snapshots[0]
    const last = account.snapshots[account.snapshots.length - 1]
    const enough = account.snapshots.length >= 2 && first && last
    return {
      accountId: account.id,
      platform: account.platform,
      followers: account.followers,
      avgViews30d: account.avgViews30d,
      posts30d: last?.posts30d ?? null,
      lastSyncedAt: account.lastSyncedAt,
      followersDelta30d: enough ? last.followers - first.followers : null,
      avgViewsDelta30d: enough ? last.avgViews30d - first.avgViews30d : null,
      history: account.snapshots.map((s) => ({ at: s.capturedAt, followers: s.followers, avgViews30d: s.avgViews30d })),
    }
  })
}
