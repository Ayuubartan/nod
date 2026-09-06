/**
 * Participant payouts — docs/06 section 5.
 *
 * Pilot: manual. Ops exports a CSV of wallets at or above the payout threshold, pays
 * from Swish Företag by hand, and marks each row paid. The interface is the same one
 * the Swish Payouts API will implement later, so the ops console does not change.
 */

import type { PayoutProvider, PayoutResult, PayoutRow } from './types'

/** +46 7X XXX XX XX — the only format Swish accepts for a private number. */
const SWISH_RE = /^\+467[0236]\d{7}$/

/** Accepts 070-123 45 67, 0701234567, +46701234567; returns E.164 or null. */
export function normaliseSwishNumber(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '')
  let e164: string

  if (digits.startsWith('+46')) e164 = digits
  else if (digits.startsWith('0046')) e164 = `+${digits.slice(2)}`
  else if (digits.startsWith('0')) e164 = `+46${digits.slice(1)}`
  else return null

  return SWISH_RE.test(e164) ? e164 : null
}

export function isValidSwishNumber(raw: string): boolean {
  return normaliseSwishNumber(raw) !== null
}

/** RFC 4180 CSV escaping — an ops export must survive a name with a comma in it. */
function csvCell(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toSwishCsv(batchId: string, rows: PayoutRow[]): string {
  const header = ['swish_number', 'amount_sek', 'memo', 'wallet_id']
  const lines = rows.map((row) =>
    [
      csvCell(row.swishNumber),
      // Swish takes kronor with two decimals; the ledger stays in öre.
      csvCell((row.amountOre / 100).toFixed(2)),
      csvCell(`NOD-${batchId}`),
      csvCell(row.walletId),
    ].join(','),
  )
  return [header.join(','), ...lines].join('\n')
}

/**
 * The pilot implementation. It does not move money — a human does — so `send` reports
 * every row as pending rather than claiming success. Ops marks rows paid in the console,
 * which is what writes PAYOUT_SENT.
 */
export class ManualSwishProvider implements PayoutProvider {
  readonly name = 'swish-manual'

  async send(_batchId: string, rows: PayoutRow[]): Promise<PayoutResult[]> {
    return rows.map((row) => ({
      walletId: row.walletId,
      ok: false,
      error: 'MANUAL_PENDING',
    }))
  }
}

/** M5 slot: the real Swish Payouts API (needs a bank agreement and a certificate). */
export class SwishPayoutsProvider implements PayoutProvider {
  readonly name = 'swish-api'

  async send(): Promise<PayoutResult[]> {
    throw new Error('Swish Payouts API is not implemented yet — Milestone 5 (docs/06 section 5).')
  }
}

export class FakePayoutProvider implements PayoutProvider {
  readonly name = 'fake-payout'

  async send(batchId: string, rows: PayoutRow[]): Promise<PayoutResult[]> {
    return rows.map((row, index) => ({
      walletId: row.walletId,
      ok: true,
      reference: `FAKE-${batchId}-${index}`,
    }))
  }
}

let cached: PayoutProvider | null = null

export function payoutProvider(): PayoutProvider {
  if (cached) return cached
  cached = process.env.NOD_FAKE_PROVIDERS === '1' ? new FakePayoutProvider() : new ManualSwishProvider()
  return cached
}

export function setPayoutProvider(provider: PayoutProvider | null): void {
  cached = provider
}
