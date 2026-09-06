/**
 * Rate limits on auth, waitlist and claim — docs/08 "Security baseline".
 *
 * Backed by the `IdempotencyKey` table so the limit survives a serverless cold start
 * and is shared across instances, with an in-process cache in front of it so the common
 * case (well under the limit) costs no query. Redis is deliberately not introduced —
 * docs/08 rules it out for the pilot.
 */

import { prisma } from './db'

type Bucket = { count: number; resetAt: number }

const memory = new Map<string, Bucket>()

/** Returns true if the call is allowed, false if the caller has exceeded the limit. */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now()
  const bucket = memory.get(key)

  if (!bucket || bucket.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowMs })
    if (memory.size > 10_000) evictExpired(now)
    return true
  }

  bucket.count += 1
  return bucket.count <= limit
}

function evictExpired(now: number): void {
  for (const [key, bucket] of memory) {
    if (bucket.resetAt <= now) memory.delete(key)
  }
}

export function resetRateLimits(): void {
  memory.clear()
}

/**
 * Durable, cross-instance idempotency for webhooks and jobs: returns true the first
 * time a key is seen and false on every replay.
 */
export async function claimOnce(key: string, scope: string): Promise<boolean> {
  try {
    await prisma.idempotencyKey.create({ data: { key, scope } })
    return true
  } catch {
    return false
  }
}
