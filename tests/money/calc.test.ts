import { describe, expect, it } from 'vitest'
import {
  creditTermsFeeOre,
  effectiveCpmOre,
  estimateParticipantOre,
  formatKrDown,
  formatOre,
  nodTake,
  participantRateCard,
  participantShare,
  payoutAllInOre,
  qualifiedViews,
  reservationOre,
  roundUpToKrona,
  settle,
  type Template,
} from '@/lib/money/calc'
import { DEFAULTS, FLOORS, sek } from '@/lib/money/rates'

/** The pilot default template: 30 kr fixed + 60 kr CPM, 28% take. */
const hybrid: Template = {
  fixedOre: DEFAULTS.fixedOre,
  cpmOre: DEFAULTS.cpmOre,
  viewFloor: DEFAULTS.viewFloor,
  takeRateBps: DEFAULTS.takeRateBps,
}

describe('participantShare / nodTake', () => {
  it('splits an all-in amount at the take rate, rounding the participant down', () => {
    // 57 kr all-in at 28% -> 41.04 kr participant (docs/05 worked example row 1)
    expect(participantShare(sek(57))).toBe(4104)
    expect(nodTake(sek(57))).toBe(1596)
  })

  it('always reconciles exactly: share + take === allIn', () => {
    for (let ore = 0; ore <= 20_000; ore += 7) {
      expect(participantShare(ore) + nodTake(ore)).toBe(ore)
    }
  })

  it('gives NOD the sub-öre remainder', () => {
    // 1 öre at 28%: floor(1 * 7200 / 10000) = 0 to the participant
    expect(participantShare(1)).toBe(0)
    expect(nodTake(1)).toBe(1)
  })

  it('honours a 0% and a 100% take rate', () => {
    expect(participantShare(sek(100), 0)).toBe(sek(100))
    expect(participantShare(sek(100), 10_000)).toBe(0)
  })

  it('rejects impossible inputs', () => {
    expect(() => participantShare(-1)).toThrow(/negative/)
    expect(() => participantShare(10.5)).toThrow(/integer/)
    expect(() => participantShare(100, 10_001)).toThrow(/0\.\.10000/)
    expect(() => participantShare(100, -1)).toThrow(/0\.\.10000/)
  })
})

describe('roundUpToKrona', () => {
  it('rounds up to the nearest whole krona', () => {
    expect(roundUpToKrona(0)).toBe(0)
    expect(roundUpToKrona(1)).toBe(100)
    expect(roundUpToKrona(100)).toBe(100)
    expect(roundUpToKrona(101)).toBe(200)
  })
})

describe('reservationOre — docs/05 worked examples', () => {
  it('450 avg views reserves 90 kr (30 + 60 x ceil(900/1000))', () => {
    expect(reservationOre(hybrid, { avgViews30d: 450 })).toBe(sek(90))
  })

  it('1,500 avg views reserves 210 kr (30 + 60 x 3)', () => {
    expect(reservationOre(hybrid, { avgViews30d: 1_500 })).toBe(sek(210))
  })

  it('5,000 avg views computes 630 kr but is capped at the 500 kr per-placement max', () => {
    expect(reservationOre(hybrid, { avgViews30d: 5_000 })).toBe(sek(500))
  })

  it('300 avg views reserves 90 kr', () => {
    expect(reservationOre(hybrid, { avgViews30d: 300 })).toBe(sek(90))
  })

  it('includes the bonus component when the template has one', () => {
    const bonusTemplate: Template = { ...hybrid, bonusOre: DEFAULTS.bonusOre, bonusAtViews: 5_000 }
    // 30 + 60 x 1 + 50 = 140 kr
    expect(reservationOre(bonusTemplate, { avgViews30d: 450 })).toBe(sek(140))
  })

  it('reserves the fixed component alone for a zero-view account', () => {
    expect(reservationOre(hybrid, { avgViews30d: 0 })).toBe(sek(30))
  })

  it('rounds the reservation up to a whole krona', () => {
    const odd: Template = { ...hybrid, fixedOre: 3_051, cpmOre: 0 }
    expect(reservationOre(odd, { avgViews30d: 0 })).toBe(3_100)
  })

  it('rejects a negative average', () => {
    expect(() => reservationOre(hybrid, { avgViews30d: -1 })).toThrow(/negative/)
  })
})

describe('payoutAllInOre', () => {
  it('pays fixed + CPM above the view floor', () => {
    expect(payoutAllInOre(hybrid, 450)).toBe(sek(57)) // 30 + 27
    expect(payoutAllInOre(hybrid, 1_500)).toBe(sek(120)) // 30 + 90
    expect(payoutAllInOre(hybrid, 5_000)).toBe(sek(330)) // 30 + 300
  })

  it('pays the fixed component only below the view floor — never a 1k minimum', () => {
    expect(payoutAllInOre(hybrid, 99)).toBe(sek(30))
    expect(payoutAllInOre(hybrid, 0)).toBe(sek(30))
  })

  it('pays CPM from exactly the floor upward', () => {
    expect(payoutAllInOre(hybrid, 100)).toBe(sek(30) + Math.floor((sek(60) * 100) / 1000))
  })

  it('adds the bonus at or above the threshold, not below', () => {
    const t: Template = { ...hybrid, bonusAtViews: 5_000, bonusOre: sek(50) }
    expect(payoutAllInOre(t, 4_999)).toBe(sek(30) + Math.floor((sek(60) * 4_999) / 1000))
    expect(payoutAllInOre(t, 5_000)).toBe(sek(330) + sek(50))
  })

  it('ignores a bonus amount with no threshold', () => {
    const t: Template = { ...hybrid, bonusAtViews: null, bonusOre: sek(50) }
    expect(payoutAllInOre(t, 10_000)).toBe(sek(30) + sek(600))
  })

  it('supports a CPM-only template', () => {
    const cpmOnly: Template = { ...hybrid, fixedOre: 0 }
    expect(payoutAllInOre(cpmOnly, 1_000)).toBe(sek(60))
    expect(payoutAllInOre(cpmOnly, 50)).toBe(0)
  })

  it('supports a fixed-only template', () => {
    const fixedOnly: Template = { ...hybrid, cpmOre: 0 }
    expect(payoutAllInOre(fixedOnly, 99_999)).toBe(sek(30))
  })

  it('rejects negative views', () => {
    expect(() => payoutAllInOre(hybrid, -1)).toThrow(/negative/)
  })
})

describe('settle — the four ledger amounts, docs/05 worked examples', () => {
  it('row 1: 450 avg views, 450 actual — brand 57, participant 41.04, NOD 15.96', () => {
    const reservation = reservationOre(hybrid, { avgViews30d: 450 })
    const s = settle(hybrid, 450, reservation)
    expect(s.allInOre).toBe(sek(57))
    expect(s.toUserOre).toBe(4_104)
    expect(s.toNodOre).toBe(1_596)
    expect(s.releaseOre).toBe(sek(90) - sek(57))
    expect(s.freeReachViews).toBe(0)
  })

  it('row 2: 1,500 avg views, 1,500 actual — brand 120, participant 86.40, NOD 33.60', () => {
    const reservation = reservationOre(hybrid, { avgViews30d: 1_500 })
    const s = settle(hybrid, 1_500, reservation)
    expect(s.allInOre).toBe(sek(120))
    expect(s.toUserOre).toBe(8_640)
    expect(s.toNodOre).toBe(3_360)
    expect(s.releaseOre).toBe(sek(210) - sek(120))
  })

  it('row 3: 5,000 avg views, 5,000 actual — brand 330, participant 237.60, NOD 92.40', () => {
    const reservation = reservationOre(hybrid, { avgViews30d: 5_000 })
    const s = settle(hybrid, 5_000, reservation)
    expect(s.allInOre).toBe(sek(330))
    expect(s.toUserOre).toBe(23_760)
    expect(s.toNodOre).toBe(9_240)
    expect(s.releaseOre).toBe(sek(500) - sek(330))
  })

  it('row 4: 300 avg views spiking to 8,000 — capped at the 90 kr reservation', () => {
    const reservation = reservationOre(hybrid, { avgViews30d: 300 })
    expect(reservation).toBe(sek(90))
    const s = settle(hybrid, 8_000, reservation)
    expect(s.allInOre).toBe(sek(90))
    expect(s.toUserOre).toBe(6_480) // 64.80 kr
    expect(s.toNodOre).toBe(2_520) // 25.20 kr
    expect(s.releaseOre).toBe(0)
    // 90 kr covers 30 fixed + 60 variable = 1,000 views; the other 7,000 are free reach.
    expect(s.freeReachViews).toBe(7_000)
  })

  it('never pays more than the reservation, for any view count', () => {
    const reservation = reservationOre(hybrid, { avgViews30d: 450 })
    for (const views of [0, 1, 99, 100, 450, 1_000, 50_000, 1_000_000]) {
      const s = settle(hybrid, views, reservation)
      expect(s.allInOre).toBeLessThanOrEqual(reservation)
      expect(s.toUserOre + s.toNodOre).toBe(s.allInOre)
      expect(s.allInOre + s.releaseOre).toBe(reservation)
    }
  })

  it('releases the whole reservation when the payout is zero', () => {
    const cpmOnly: Template = { ...hybrid, fixedOre: 0 }
    const s = settle(cpmOnly, 0, sek(90))
    expect(s.allInOre).toBe(0)
    expect(s.releaseOre).toBe(sek(90))
  })

  it('rejects a negative reservation', () => {
    expect(() => settle(hybrid, 100, -1)).toThrow(/negative/)
  })
})

describe('qualifiedViews — docs/03 verification check 6', () => {
  it('applies the geo factor and the fraud discount', () => {
    expect(qualifiedViews(1_000)).toBe(1_000)
    expect(qualifiedViews(1_000, 0.8)).toBe(800)
    expect(qualifiedViews(1_000, 1, 0.25)).toBe(750)
    expect(qualifiedViews(1_000, 0.8, 0.5)).toBe(400)
  })

  it('floors fractional results', () => {
    expect(qualifiedViews(999, 0.5)).toBe(499)
  })

  it('rejects out-of-range factors', () => {
    expect(() => qualifiedViews(-1)).toThrow(/negative/)
    expect(() => qualifiedViews(10, 1.5)).toThrow(/geoFactor/)
    expect(() => qualifiedViews(10, 1, 2)).toThrow(/fraudDiscount/)
  })
})

describe('effectiveCpmOre', () => {
  it('is spend per 1,000 qualified views', () => {
    expect(effectiveCpmOre(sek(600_000), 7_500_000)).toBe(sek(80))
  })

  it('is zero before any views', () => {
    expect(effectiveCpmOre(sek(100), 0)).toBe(0)
  })
})

describe('participant-facing numbers', () => {
  it('shows the net rate card: 20 kr per post + 43 kr per 1,000 views', () => {
    const card = participantRateCard(hybrid)
    expect(card.fixedOre).toBe(2_160) // 21.60 kr -> displays as 21 kr
    expect(card.cpmOre).toBe(4_320) // 43.20 kr -> displays as 43 kr
    expect(formatKrDown(card.cpmOre)).toBe('43 kr')
  })

  it('estimates the same number the settlement will pay', () => {
    for (const views of [400, 1_500, 5_000]) {
      const estimate = estimateParticipantOre(hybrid, views)
      const actual = settle(hybrid, views, sek(10_000)).toUserOre
      expect(estimate).toBe(actual)
    }
  })

  it('matches the landing-page example rows', () => {
    // docs/01 section 3: 400 -> ~38 kr, 1,500 -> ~88 kr, 5,000 -> ~245 kr
    expect(formatKrDown(estimateParticipantOre(hybrid, 400))).toBe('38 kr')
    expect(formatKrDown(estimateParticipantOre(hybrid, 1_500))).toBe('86 kr')
    expect(formatKrDown(estimateParticipantOre(hybrid, 5_000))).toBe('237 kr')
  })
})

describe('creditTermsFeeOre', () => {
  it('is 4% on an invoiced budget and 0% on card', () => {
    expect(creditTermsFeeOre(sek(100_000), DEFAULTS.creditTermsFeeBps)).toBe(sek(4_000))
    expect(creditTermsFeeOre(sek(100_000), 0)).toBe(0)
  })

  it('rejects a negative fee', () => {
    expect(() => creditTermsFeeOre(100, -1)).toThrow(/non-negative/)
  })
})

describe('formatting', () => {
  it('formats participant copy down to whole kronor', () => {
    expect(formatKrDown(4_199)).toBe('41 kr')
    expect(formatKrDown(0)).toBe('0 kr')
  })

  it('formats exact amounts for ledgers', () => {
    expect(formatOre(4_104).replace(/ /g, ' ')).toContain('41,04')
  })
})

describe('floors are below defaults', () => {
  it('so a brand can always price down to the floor', () => {
    expect(FLOORS.cpmOre).toBeLessThan(DEFAULTS.cpmOre)
    expect(FLOORS.fixedOre).toBeLessThan(DEFAULTS.fixedOre)
    expect(FLOORS.viewFloor).toBeLessThan(DEFAULTS.viewFloor)
  })
})
