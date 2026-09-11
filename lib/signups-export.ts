/**
 * CSV export of signups for ops — the waitlist and brand enquiries.
 *
 * Pure: takes rows, returns text. The route handler at /ops/signups/export does the
 * auth, the query and the audit row; this module is what the tests cover, because the
 * ways a CSV goes wrong (a comma in a city, a quote in a message, a newline in a brand
 * enquiry, an address starting with "=" that Excel runs as a formula) are all here.
 *
 * Personal data leaves the system through this file. Every export is one AuditLog
 * row (WaitlistEntry / BrandEnquiry, event EXPORT, the ops user as actor), so
 * "who downloaded the list and when" is always answerable (docs/07 section 3).
 */

import type { AccountPlatform } from '@prisma/client'

export type ExportKind = 'waitlist' | 'enquiries'

export function isExportKind(value: string | null | undefined): value is ExportKind {
  return value === 'waitlist' || value === 'enquiries'
}

/**
 * Excel opens a bare UTF-8 file as Latin-1 and mangles å/ä/ö. The byte-order mark is the
 * only thing it reliably honours, and every other reader ignores it.
 */
export const BOM = '﻿'

/**
 * Quote a single cell. Always quoted, so a reader never has to guess; a leading `=`,
 * `+`, `-` or `@` gets a leading apostrophe so a spreadsheet shows it rather than
 * evaluating it — a signup form is exactly where someone types `=HYPERLINK(...)`.
 */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '""'
  let text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join('|') : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export function csv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.map(cell).join(','), ...rows.map((row) => row.map(cell).join(','))]
  return BOM + lines.join('\r\n') + '\r\n'
}

export type WaitlistRow = {
  position: number
  createdAt: Date
  email: string
  phone: string | null
  displayName: string | null
  handle: string | null
  platform: AccountPlatform | null
  city: string
  ageBracket: string | null
  followersBracket: string | null
  categories: string[]
  points: number
  level: number
  verifiedReferrals: number
  referralCode: string
  referredBy: string | null
  emailVerifiedAt: Date | null
  phoneVerifiedAt: Date | null
  accessGrantedAt: Date | null
  convertedUserId: string | null
  smsConsentAt: Date | null
  marketingConsentAt: Date | null
  smsOptOutAt: Date | null
  signupSource: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
}

export const WAITLIST_HEADER = [
  'position',
  'joined_at',
  'email',
  'phone',
  'display_name',
  'handle',
  'platform',
  'city',
  'age_bracket',
  'followers_bracket',
  'categories',
  'points',
  'level',
  'verified_referrals',
  'referral_code',
  'referred_by',
  'email_verified_at',
  'phone_verified_at',
  'access_granted_at',
  'converted',
  'sms_consent_at',
  'marketing_consent_at',
  'sms_opt_out_at',
  'signup_source',
  'utm_source',
  'utm_medium',
  'utm_campaign',
] as const

export function waitlistCsv(rows: readonly WaitlistRow[]): string {
  return csv(
    WAITLIST_HEADER,
    rows.map((r) => [
      r.position,
      r.createdAt,
      r.email,
      r.phone,
      r.displayName,
      r.handle,
      r.platform,
      r.city,
      r.ageBracket,
      r.followersBracket,
      r.categories,
      r.points,
      r.level,
      r.verifiedReferrals,
      r.referralCode,
      r.referredBy,
      r.emailVerifiedAt,
      r.phoneVerifiedAt,
      r.accessGrantedAt,
      r.convertedUserId ? 'yes' : 'no',
      r.smsConsentAt,
      r.marketingConsentAt,
      r.smsOptOutAt,
      r.signupSource,
      r.utmSource,
      r.utmMedium,
      r.utmCampaign,
    ]),
  )
}

export type EnquiryRow = {
  createdAt: Date
  company: string
  name: string
  email: string
  budgetBracket: string
  objective: string | null
  message: string | null
}

export const ENQUIRY_HEADER = ['received_at', 'company', 'name', 'email', 'budget_bracket', 'objective', 'message'] as const

export function enquiriesCsv(rows: readonly EnquiryRow[]): string {
  return csv(
    ENQUIRY_HEADER,
    rows.map((r) => [r.createdAt, r.company, r.name, r.email, r.budgetBracket, r.objective, r.message]),
  )
}

/** `boogaa-waitlist-2026-09-11.csv` — sorts by date in a downloads folder. */
export function exportFilename(kind: ExportKind, now = new Date()): string {
  return `boogaa-${kind}-${now.toISOString().slice(0, 10)}.csv`
}
