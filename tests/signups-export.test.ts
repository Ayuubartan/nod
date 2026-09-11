import { describe, expect, it } from 'vitest'
import { BOM, cell, csv, enquiriesCsv, exportFilename, isExportKind, waitlistCsv, WAITLIST_HEADER } from '@/lib/signups-export'

/** The ways a CSV of signups goes wrong, each pinned. */

describe('cell', () => {
  it('always quotes, and doubles inner quotes', () => {
    expect(cell('Stockholm')).toBe('"Stockholm"')
    expect(cell('say "hi"')).toBe('"say ""hi"""')
  })

  it('keeps commas and newlines inside the quotes', () => {
    expect(cell('a, b')).toBe('"a, b"')
    expect(cell('line one\nline two')).toBe('"line one\nline two"')
  })

  it('neutralises spreadsheet formulas — a signup form is where someone types one', () => {
    expect(cell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"')
    expect(cell('+4670')).toBe('"\'+4670"')
    expect(cell('-1')).toBe('"\'-1"')
    expect(cell('@handle')).toBe('"\'@handle"')
  })

  it('renders null and undefined as an empty cell, dates as ISO, arrays joined by |', () => {
    expect(cell(null)).toBe('""')
    expect(cell(undefined)).toBe('""')
    expect(cell(new Date('2026-09-11T08:00:00Z'))).toBe('"2026-09-11T08:00:00.000Z"')
    expect(cell(['fitness', 'food'])).toBe('"fitness|food"')
    expect(cell(0)).toBe('"0"')
  })
})

describe('csv', () => {
  it('starts with the BOM so Excel reads å/ä/ö, and uses CRLF', () => {
    const out = csv(['a', 'b'], [['å', 1]])
    expect(out.startsWith(BOM)).toBe(true)
    expect(out).toBe(`${BOM}"a","b"\r\n"å","1"\r\n`)
  })
})

describe('waitlistCsv', () => {
  const row = {
    position: 317,
    createdAt: new Date('2026-09-10T12:00:00Z'),
    email: 'anna@example.se',
    phone: '+46701234567',
    displayName: 'Anna',
    handle: 'anna.ek',
    platform: 'INSTAGRAM' as const,
    city: 'stockholm',
    ageBracket: '21-25',
    followersBracket: '500-2k',
    categories: ['fitness', 'food'],
    points: 40,
    level: 2,
    verifiedReferrals: 3,
    referralCode: 'ANNA7',
    referredBy: 'BO123',
    emailVerifiedAt: new Date('2026-09-10T12:01:00Z'),
    phoneVerifiedAt: null,
    accessGrantedAt: null,
    convertedUserId: 'usr_1',
    smsConsentAt: null,
    marketingConsentAt: null,
    smsOptOutAt: null,
    signupSource: 'landing',
    utmSource: 'tiktok',
    utmMedium: null,
    utmCampaign: null,
  }

  it('has one column per header, in header order, for every row', () => {
    const lines = waitlistCsv([row]).slice(BOM.length).trimEnd().split('\r\n')
    expect(lines).toHaveLength(2)
    const count = (line: string) => line.split('","').length
    expect(count(lines[0]!)).toBe(WAITLIST_HEADER.length)
    expect(count(lines[1]!)).toBe(WAITLIST_HEADER.length)
  })

  it('shows conversion as yes/no rather than leaking the user id', () => {
    const out = waitlistCsv([row])
    expect(out).toContain('"yes"')
    expect(out).not.toContain('usr_1')
    expect(waitlistCsv([{ ...row, convertedUserId: null }])).toContain('"no"')
  })

  it('escapes the phone so a spreadsheet does not treat +46 as a formula', () => {
    expect(waitlistCsv([row])).toContain('"\'+46701234567"')
  })
})

describe('enquiriesCsv', () => {
  it('survives a multi-line message with quotes and commas', () => {
    const out = enquiriesCsv([
      {
        createdAt: new Date('2026-09-11T09:00:00Z'),
        company: 'Acme, AB',
        name: 'Bo',
        email: 'bo@acme.se',
        budgetBracket: '50-100k',
        objective: null,
        message: 'We want "awareness",\nStockholm first.',
      },
    ])
    expect(out).toContain('"Acme, AB"')
    expect(out).toContain('"We want ""awareness"",\nStockholm first."')
  })
})

describe('isExportKind / exportFilename', () => {
  it('accepts only the two kinds', () => {
    expect(isExportKind('waitlist')).toBe(true)
    expect(isExportKind('enquiries')).toBe(true)
    expect(isExportKind('users')).toBe(false)
    expect(isExportKind(null)).toBe(false)
  })

  it('names the file by kind and date', () => {
    expect(exportFilename('waitlist', new Date('2026-09-11T23:59:00Z'))).toBe('boogaa-waitlist-2026-09-11.csv')
  })
})
