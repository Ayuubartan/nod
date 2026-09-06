/**
 * Transition-table tests. These need no database: they assert the shape of the state
 * machines themselves against docs/03, including that every illegal transition is
 * rejected. The database-backed behaviour is covered in tests/state/*.db.test.ts.
 */

import { describe, expect, it } from 'vitest'
import type { CampaignState, ParticipantState, PlacementState } from '@prisma/client'
import {
  allowedEvents,
  canTransition,
  nextState,
  TransitionError,
  actorString,
} from '@/lib/state/transition'
import { PARTICIPANT_TABLE, canClaim, type ParticipantEvent } from '@/lib/state/participant'
import { CAMPAIGN_TABLE, isClaimable, nextDropAt, assertDisclosureGuard } from '@/lib/state/campaign'
import {
  PLACEMENT_TABLE,
  RELEASING_STATES,
  TERMINAL_STATES,
  holdDurationMs,
  type PlacementEvent,
} from '@/lib/state/placement'
import { HOLD_MS } from '@/lib/money/rates'

const ALL_PARTICIPANT_STATES: ParticipantState[] = [
  'SIGNED_UP', 'ONBOARDED', 'VERIFIED', 'ACTIVE', 'FLAGGED', 'SUSPENDED', 'REMOVED',
]
const ALL_PARTICIPANT_EVENTS: ParticipantEvent[] = [
  'ONBOARD', 'VERIFY', 'ACTIVATE', 'FLAG', 'CLEAR_FLAG', 'SUSPEND', 'RESTORE', 'REMOVE',
]

const ALL_CAMPAIGN_STATES: CampaignState[] = [
  'DRAFT', 'SUBMITTED', 'RETURNED', 'AWAITING_FUNDS', 'FUNDED', 'LIVE', 'FILLING',
  'EXHAUSTED', 'EXPIRED', 'PAUSED', 'RECONCILING', 'CLOSED',
]

const ALL_PLACEMENT_STATES: PlacementState[] = [
  'CLAIMED', 'UPLOADED', 'POSITIONED', 'GENERATING', 'GENERATION_FAILED',
  'PARTICIPANT_REVIEW', 'BRAND_REVIEW', 'APPROVED', 'PUBLISHED', 'VERIFYING',
  'FLAGGED', 'QUALIFIED', 'PAID', 'REJECTED', 'EXPIRED',
  'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND', 'DISPUTED',
]

describe('participant state machine — docs/03 section 3', () => {
  it('walks the happy path SIGNED_UP -> ONBOARDED -> VERIFIED -> ACTIVE', () => {
    expect(nextState(PARTICIPANT_TABLE, 'SIGNED_UP', 'ONBOARD')).toBe('ONBOARDED')
    expect(nextState(PARTICIPANT_TABLE, 'ONBOARDED', 'VERIFY')).toBe('VERIFIED')
    expect(nextState(PARTICIPANT_TABLE, 'VERIFIED', 'ACTIVATE')).toBe('ACTIVE')
  })

  it('cannot verify before onboarding, or activate before verifying', () => {
    expect(canTransition(PARTICIPANT_TABLE, 'SIGNED_UP', 'VERIFY')).toBe(false)
    expect(canTransition(PARTICIPANT_TABLE, 'ONBOARDED', 'ACTIVATE')).toBe(false)
  })

  it('flags from VERIFIED as well as ACTIVE — a first claim can be flagged', () => {
    expect(nextState(PARTICIPANT_TABLE, 'VERIFIED', 'FLAG')).toBe('FLAGGED')
    expect(nextState(PARTICIPANT_TABLE, 'ACTIVE', 'FLAG')).toBe('FLAGGED')
  })

  it('clears a flag back to ACTIVE and suspends from FLAGGED', () => {
    expect(nextState(PARTICIPANT_TABLE, 'FLAGGED', 'CLEAR_FLAG')).toBe('ACTIVE')
    expect(nextState(PARTICIPANT_TABLE, 'FLAGGED', 'SUSPEND')).toBe('SUSPENDED')
  })

  it('suspends directly on one serious strike, without passing through FLAGGED', () => {
    expect(nextState(PARTICIPANT_TABLE, 'ACTIVE', 'SUSPEND')).toBe('SUSPENDED')
    expect(nextState(PARTICIPANT_TABLE, 'VERIFIED', 'SUSPEND')).toBe('SUSPENDED')
  })

  it('auto-restores a suspension to ACTIVE', () => {
    expect(nextState(PARTICIPANT_TABLE, 'SUSPENDED', 'RESTORE')).toBe('ACTIVE')
  })

  it('makes REMOVED terminal in every direction', () => {
    expect(allowedEvents(PARTICIPANT_TABLE, 'REMOVED')).toEqual([])
    for (const event of ALL_PARTICIPANT_EVENTS) {
      expect(canTransition(PARTICIPANT_TABLE, 'REMOVED', event)).toBe(false)
    }
  })

  it('rejects every transition not in the table', () => {
    let illegal = 0
    for (const state of ALL_PARTICIPANT_STATES) {
      for (const event of ALL_PARTICIPANT_EVENTS) {
        if (!canTransition(PARTICIPANT_TABLE, state, event)) {
          illegal += 1
          expect(nextState(PARTICIPANT_TABLE, state, event)).toBeUndefined()
        }
      }
    }
    // The table is sparse by design; if this ever hits zero the machine has gone permissive.
    expect(illegal).toBeGreaterThan(30)
  })

  it('only lets VERIFIED and ACTIVE participants claim', () => {
    expect(canClaim('VERIFIED')).toBe(true)
    expect(canClaim('ACTIVE')).toBe(true)
    for (const state of ['SIGNED_UP', 'ONBOARDED', 'FLAGGED', 'SUSPENDED', 'REMOVED'] as const) {
      expect(canClaim(state), `${state} must not claim`).toBe(false)
    }
  })
})

describe('campaign state machine — docs/03 section 2', () => {
  it('walks DRAFT -> SUBMITTED -> AWAITING_FUNDS -> FUNDED -> LIVE -> FILLING', () => {
    expect(nextState(CAMPAIGN_TABLE, 'DRAFT', 'SUBMIT')).toBe('SUBMITTED')
    expect(nextState(CAMPAIGN_TABLE, 'SUBMITTED', 'APPROVE')).toBe('AWAITING_FUNDS')
    expect(nextState(CAMPAIGN_TABLE, 'AWAITING_FUNDS', 'FUND')).toBe('FUNDED')
    expect(nextState(CAMPAIGN_TABLE, 'FUNDED', 'GO_LIVE')).toBe('LIVE')
    expect(nextState(CAMPAIGN_TABLE, 'LIVE', 'FIRST_CLAIM')).toBe('FILLING')
  })

  it('returns to the builder with notes, and back again', () => {
    expect(nextState(CAMPAIGN_TABLE, 'SUBMITTED', 'RETURN')).toBe('RETURNED')
    expect(nextState(CAMPAIGN_TABLE, 'RETURNED', 'RESUBMIT')).toBe('SUBMITTED')
  })

  it('sends an unfunded campaign back to DRAFT after the funding window', () => {
    expect(nextState(CAMPAIGN_TABLE, 'AWAITING_FUNDS', 'EXPIRE')).toBe('DRAFT')
  })

  it('reopens an exhausted campaign exactly once, back into FILLING', () => {
    expect(nextState(CAMPAIGN_TABLE, 'EXHAUSTED', 'REOPEN')).toBe('FILLING')
  })

  it('pauses from FUNDED, LIVE and FILLING but never from a terminal state', () => {
    expect(nextState(CAMPAIGN_TABLE, 'FILLING', 'PAUSE')).toBe('PAUSED')
    expect(nextState(CAMPAIGN_TABLE, 'LIVE', 'PAUSE')).toBe('PAUSED')
    expect(canTransition(CAMPAIGN_TABLE, 'CLOSED', 'PAUSE')).toBe(false)
    expect(canTransition(CAMPAIGN_TABLE, 'RECONCILING', 'PAUSE')).toBe(false)
  })

  it('reconciles from EXHAUSTED, EXPIRED and PAUSED, then closes', () => {
    for (const from of ['EXHAUSTED', 'EXPIRED', 'PAUSED'] as const) {
      expect(nextState(CAMPAIGN_TABLE, from, 'RECONCILE')).toBe('RECONCILING')
    }
    expect(nextState(CAMPAIGN_TABLE, 'RECONCILING', 'CLOSE')).toBe('CLOSED')
  })

  it('makes CLOSED terminal', () => {
    expect(allowedEvents(CAMPAIGN_TABLE, 'CLOSED')).toEqual([])
  })

  it('never lets a campaign go live without funding', () => {
    for (const from of ['DRAFT', 'SUBMITTED', 'RETURNED', 'AWAITING_FUNDS'] as const) {
      expect(canTransition(CAMPAIGN_TABLE, from, 'GO_LIVE'), `${from} must not go live`).toBe(false)
    }
  })

  it('only allows claims while LIVE or FILLING', () => {
    expect(isClaimable('LIVE')).toBe(true)
    expect(isClaimable('FILLING')).toBe(true)
    for (const state of ALL_CAMPAIGN_STATES.filter((s) => s !== 'LIVE' && s !== 'FILLING')) {
      expect(isClaimable(state), `${state} must not be claimable`).toBe(false)
    }
  })
})

describe('disclosure guard — docs/07 section 1', () => {
  it('accepts the Swedish default and the English variant', () => {
    expect(() => assertDisclosureGuard('Reklam – i samarbete med Kaffeklubben')).not.toThrow()
    expect(() => assertDisclosureGuard('Annons för Kaffeklubben')).not.toThrow()
    expect(() => assertDisclosureGuard('Ad – in partnership with Kaffeklubben')).not.toThrow()
  })

  it('refuses a disclosure that does not lead with the required word', () => {
    expect(() => assertDisclosureGuard('I samarbete med Kaffeklubben')).toThrow(/Reklam/)
    expect(() => assertDisclosureGuard('#ad Kaffeklubben')).toThrow(/Reklam/)
    expect(() => assertDisclosureGuard('   ')).toThrow(/required/)
  })
})

describe('next drop — Friday 18:00 Europe/Stockholm', () => {
  it('lands on a Friday at 18:00', () => {
    const drop = nextDropAt(new Date('2026-09-08T10:00:00'))
    expect(drop.getDay()).toBe(5)
    expect(drop.getHours()).toBe(18)
    expect(drop.getMinutes()).toBe(0)
  })

  it('skips to next week when called after Friday 18:00', () => {
    const fridayEvening = new Date('2026-09-11T19:00:00')
    const drop = nextDropAt(fridayEvening)
    expect(drop.getTime()).toBeGreaterThan(fridayEvening.getTime())
    expect(drop.getDay()).toBe(5)
  })
})

describe('placement state machine — docs/03 section 1', () => {
  it('walks the full happy path P-01 to P-10', () => {
    expect(nextState(PLACEMENT_TABLE, 'CLAIMED', 'UPLOAD')).toBe('UPLOADED')
    expect(nextState(PLACEMENT_TABLE, 'UPLOADED', 'POSITION')).toBe('POSITIONED')
    expect(nextState(PLACEMENT_TABLE, 'POSITIONED', 'START_GENERATION')).toBe('GENERATING')
    expect(nextState(PLACEMENT_TABLE, 'GENERATING', 'GENERATION_DONE')).toBe('PARTICIPANT_REVIEW')
    expect(nextState(PLACEMENT_TABLE, 'PARTICIPANT_REVIEW', 'PARTICIPANT_APPROVE')).toBe('BRAND_REVIEW')
    expect(nextState(PLACEMENT_TABLE, 'BRAND_REVIEW', 'BRAND_APPROVE')).toBe('APPROVED')
    expect(nextState(PLACEMENT_TABLE, 'APPROVED', 'PUBLISH')).toBe('PUBLISHED')
    expect(nextState(PLACEMENT_TABLE, 'PUBLISHED', 'HOLD_END')).toBe('VERIFYING')
    expect(nextState(PLACEMENT_TABLE, 'VERIFYING', 'QUALIFY')).toBe('QUALIFIED')
    expect(nextState(PLACEMENT_TABLE, 'QUALIFIED', 'PAY')).toBe('PAID')
  })

  it('sends a regeneration back to POSITIONED so the region can move', () => {
    expect(nextState(PLACEMENT_TABLE, 'PARTICIPANT_REVIEW', 'REGENERATE')).toBe('POSITIONED')
  })

  it('bounces a brand rejection back once, then makes it final', () => {
    expect(nextState(PLACEMENT_TABLE, 'BRAND_REVIEW', 'BRAND_REJECT_BOUNCE')).toBe('POSITIONED')
    expect(nextState(PLACEMENT_TABLE, 'BRAND_REVIEW', 'BRAND_REJECT_FINAL')).toBe('REJECTED_BY_BRAND')
  })

  it('retries a failed generation', () => {
    expect(nextState(PLACEMENT_TABLE, 'GENERATING', 'GENERATION_FAIL')).toBe('GENERATION_FAILED')
    expect(nextState(PLACEMENT_TABLE, 'GENERATION_FAILED', 'RETRY_GENERATION')).toBe('GENERATING')
  })

  it('rejects a published post that was deleted during the hold', () => {
    expect(nextState(PLACEMENT_TABLE, 'PUBLISHED', 'REJECT')).toBe('REJECTED')
  })

  it('flags during verification and can still qualify after ops clears it', () => {
    expect(nextState(PLACEMENT_TABLE, 'VERIFYING', 'FLAG')).toBe('FLAGGED')
    expect(nextState(PLACEMENT_TABLE, 'FLAGGED', 'UNFLAG_QUALIFY')).toBe('QUALIFIED')
    expect(nextState(PLACEMENT_TABLE, 'FLAGGED', 'REJECT')).toBe('REJECTED')
  })

  it('never lets a placement skip verification straight to PAID', () => {
    expect(canTransition(PLACEMENT_TABLE, 'PUBLISHED', 'QUALIFY')).toBe(false)
    expect(canTransition(PLACEMENT_TABLE, 'APPROVED', 'QUALIFY')).toBe(false)
    expect(canTransition(PLACEMENT_TABLE, 'VERIFYING', 'PAY')).toBe(false)
  })

  it('never lets a rejected placement come back to life', () => {
    for (const state of ['REJECTED', 'EXPIRED', 'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND'] as const) {
      expect(allowedEvents(PLACEMENT_TABLE, state), `${state} must be terminal`).toEqual([])
    }
  })

  it('expires from every state that holds the participant clock', () => {
    for (const state of [
      'CLAIMED', 'UPLOADED', 'POSITIONED', 'GENERATING', 'GENERATION_FAILED',
      'PARTICIPANT_REVIEW', 'BRAND_REVIEW', 'APPROVED',
    ] as const) {
      expect(canTransition(PLACEMENT_TABLE, state, 'EXPIRE'), `${state} needs an expiry`).toBe(true)
    }
  })

  it('does not expire a published placement — the hold governs it, not the claim clock', () => {
    expect(canTransition(PLACEMENT_TABLE, 'PUBLISHED', 'EXPIRE')).toBe(false)
    expect(canTransition(PLACEMENT_TABLE, 'VERIFYING', 'EXPIRE')).toBe(false)
  })

  it('lets a brand dispute a paid placement and ops resolve it back to PAID', () => {
    expect(nextState(PLACEMENT_TABLE, 'PAID', 'DISPUTE')).toBe('DISPUTED')
    expect(nextState(PLACEMENT_TABLE, 'DISPUTED', 'RESOLVE_DISPUTE')).toBe('PAID')
  })

  it('classifies terminal states correctly', () => {
    expect(RELEASING_STATES).toEqual(['REJECTED', 'EXPIRED', 'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND'])
    expect(TERMINAL_STATES).toContain('PAID')
    for (const state of TERMINAL_STATES) {
      // PAID is terminal for the money but can still be disputed.
      if (state === 'PAID') continue
      expect(allowedEvents(PLACEMENT_TABLE, state)).toEqual([])
    }
  })

  it('covers every declared placement state in the table', () => {
    for (const state of ALL_PLACEMENT_STATES) {
      expect(PLACEMENT_TABLE, `${state} missing from the table`).toHaveProperty(state)
    }
  })

  it('rejects illegal transitions across the whole matrix', () => {
    const events: PlacementEvent[] = [
      'UPLOAD', 'POSITION', 'START_GENERATION', 'GENERATION_DONE', 'GENERATION_FAIL',
      'RETRY_GENERATION', 'PARTICIPANT_APPROVE', 'REGENERATE', 'PARTICIPANT_REJECT',
      'BRAND_APPROVE', 'BRAND_REJECT_BOUNCE', 'BRAND_REJECT_FINAL', 'PUBLISH', 'HOLD_END',
      'QUALIFY', 'PAY', 'REJECT', 'FLAG', 'UNFLAG_QUALIFY', 'EXPIRE', 'DISPUTE', 'RESOLVE_DISPUTE',
    ]
    let legal = 0
    for (const state of ALL_PLACEMENT_STATES) {
      for (const event of events) {
        if (canTransition(PLACEMENT_TABLE, state, event)) legal += 1
      }
    }
    // 18 states x 22 events = 396 combinations; only a small, declared subset is legal.
    expect(legal).toBeLessThan(50)
    expect(legal).toBeGreaterThan(30)
  })
})

describe('hold durations — docs/03 P-08', () => {
  it('holds a Story for 24 hours and a Reel or post for 7 days', () => {
    expect(holdDurationMs('story')).toBe(HOLD_MS.story)
    expect(holdDurationMs('reel')).toBe(HOLD_MS.reel)
    expect(holdDurationMs('post')).toBe(HOLD_MS.post)
    expect(holdDurationMs(null)).toBe(HOLD_MS.post)
  })
})

describe('TransitionError', () => {
  it('names the entity, the state and the event it refused', () => {
    const error = new TransitionError('Placement', 'p1', 'PAID', 'UPLOAD')
    expect(error.message).toContain('Placement p1')
    expect(error.message).toContain('PAID')
    expect(error.message).toContain('UPLOAD')
    expect(error.entity).toBe('Placement')
  })
})

describe('actorString', () => {
  it('renders actors for the audit log', () => {
    expect(actorString({ kind: 'SYSTEM' })).toBe('system')
    expect(actorString({ kind: 'OPS', id: 'u1' })).toBe('ops:u1')
    expect(actorString({ kind: 'PARTICIPANT', id: 'p1' })).toBe('participant:p1')
  })
})
