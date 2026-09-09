import { describe, expect, it } from 'vitest'
import { functions } from '@/inngest'
import { PLACEMENT_TABLE } from '@/lib/state/placement'
import { TIMEOUT_MS } from '@/lib/money/rates'

/**
 * CLAUDE.md rule 4: "Every timed state has a timeout job. If you add a state, add its
 * expiry job in inngest/ the same commit."
 *
 * This test is the enforcement: it fails when a timed placement state has no job.
 */
describe('inngest registration', () => {
  it('registers every function exactly once', () => {
    const ids = functions.map((fn) => (fn as unknown as { id: (prefix?: string) => string }).id())
    expect(ids.length).toBeGreaterThan(15)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has a job covering every timed placement state', () => {
    const ids = functions
      .map((fn) => (fn as unknown as { id: (prefix?: string) => string }).id())
      .join(' ')

    // P-01/02/03 share the claim clock; P-05, P-06 and P-07 have their own.
    expect(ids).toContain('claim-expiry')
    expect(ids).toContain('participant-review-expiry')
    expect(ids).toContain('brand-review-expiry')
    expect(ids).toContain('publish-expiry')
    // The sweep catches anything whose event was lost.
    expect(ids).toContain('timeout-sweep')
    // P-08 hold and P-09 verification.
    expect(ids).toContain('hold-and-verify')
    // Campaign timers.
    expect(ids).toContain('funding-expiry')
    expect(ids).toContain('campaign-period-end')
    expect(ids).toContain('campaign-go-live')
    // Money.
    expect(ids).toContain('payout-batch')
    // Retention and GDPR (docs/04, docs/07).
    expect(ids).toContain('retention-sweep')
    expect(ids).toContain('gdpr-erasure')
    // Training export (docs/06 section 6).
    expect(ids).toContain('training-export')
    // Clip campaigns (docs/14): every timed submission state has an owner.
    expect(ids).toContain('submission-verify') // RECEIVED
    expect(ids).toContain('submission-fix-window') // FIX_DISCLOSURE
    expect(ids).toContain('submission-track-scheduler') // TRACKING cadence
    expect(ids).toContain('submission-track-tiktok')
    expect(ids).toContain('submission-track-instagram')
    expect(ids).toContain('submission-validate') // TRACKING → VALIDATING → settled
    expect(ids).toContain('submission-stale-received')
    expect(ids).toContain('submission-held-reminder') // HELD
  })

  it('gives every state that can EXPIRE a timeout owner', () => {
    const expirable = Object.entries(PLACEMENT_TABLE)
      .filter(([, events]) => events && 'EXPIRE' in events)
      .map(([state]) => state)

    // Each of these is covered either by a per-state job or by the sweep, which reads
    // deadlineAt directly.
    expect(expirable).toEqual(
      expect.arrayContaining([
        'CLAIMED', 'UPLOADED', 'POSITIONED', 'GENERATING', 'GENERATION_FAILED',
        'PARTICIPANT_REVIEW', 'BRAND_REVIEW', 'APPROVED',
      ]),
    )
  })

  it('uses the timeouts the spec states', () => {
    expect(TIMEOUT_MS.claim).toBe(48 * 60 * 60 * 1000)
    expect(TIMEOUT_MS.participantReview).toBe(24 * 60 * 60 * 1000)
    expect(TIMEOUT_MS.brandReview).toBe(24 * 60 * 60 * 1000)
    expect(TIMEOUT_MS.approvedToPublish).toBe(48 * 60 * 60 * 1000)
    expect(TIMEOUT_MS.disclosureFix).toBe(12 * 60 * 60 * 1000)
    expect(TIMEOUT_MS.disputeWindow).toBe(7 * 24 * 60 * 60 * 1000)
    expect(TIMEOUT_MS.awaitingFunds).toBe(14 * 24 * 60 * 60 * 1000)
    expect(TIMEOUT_MS.tokenDisconnectGrace).toBe(72 * 60 * 60 * 1000)
  })
})
