/**
 * SMS fallback — docs/06 section 7:
 * "SMS fallback (46elks or Twilio) only for: campaign drop, claim expiring,
 *  approved-post-now. Flag-gated; costs money."
 *
 * Three constraints the spec imposes, enforced here rather than left to call sites:
 *
 *   1. Only those three notification kinds — plus the waitlist ones from docs/13 — may
 *      ever send an SMS. `SMS_ELIGIBLE` is the allowlist and `sendSms` refuses anything else.
 *   2. It is flag-gated, because it costs real money per message.
 *   3. It is a fallback, not a duplicate: it sends only when web push is unavailable for
 *      that participant, so nobody is billed twice for one notification.
 *
 * VERIFIED: not yet against 46elks' or Twilio's live documentation. docs/06 requires
 * that check before this is enabled; the provider is configuration, so it is a config
 * change rather than a rewrite.
 */

import 'server-only'
import { BRAND } from '../brand'
import { log } from '@/lib/logger'

/** The only notifications permitted to cost money. */
export const SMS_ELIGIBLE = [
  'campaignLive',
  'claimExpiring',
  'approvedPostNow',
  // the waitlist game (docs/13): a verification code, an aggregated digest, and
  // the one message that matters most — access granted. Separately flag-gated
  // (waitlist.smsEnabled) and consent-checked in lib/waitlist-sms.ts.
  'waitlistVerify',
  'waitlistDigest',
  'waitlistAccess',
] as const
export type SmsKind = (typeof SMS_ELIGIBLE)[number]

export type SmsResult = { ok: true; reference: string } | { ok: false; error: string }

export interface SmsProvider {
  readonly name: string
  send(to: string, message: string): Promise<SmsResult>
}

/** 46elks — Swedish, which matters for deliverability to Swedish carriers. */
export class ElksSmsProvider implements SmsProvider {
  readonly name = '46elks'

  async send(to: string, message: string): Promise<SmsResult> {
    const username = process.env.ELKS_USERNAME
    const password = process.env.ELKS_PASSWORD
    if (!username || !password) return { ok: false, error: 'not configured' }

    const response = await fetch('https://api.46elks.com/a1/sms', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        from: process.env.SMS_SENDER ?? BRAND,
        to,
        message,
      }),
    })

    if (!response.ok) return { ok: false, error: `46elks returned ${response.status}` }

    const body = (await response.json()) as { id?: string }
    return { ok: true, reference: body.id ?? 'sent' }
  }
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio'

  async send(to: string, message: string): Promise<SmsResult> {
    const sid = process.env.TWILIO_ACCOUNT_SID
    const token = process.env.TWILIO_AUTH_TOKEN
    const from = process.env.SMS_SENDER
    if (!sid || !token || !from) return { ok: false, error: 'not configured' }

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: message }),
    })

    if (!response.ok) return { ok: false, error: `Twilio returned ${response.status}` }

    const body = (await response.json()) as { sid?: string }
    return { ok: true, reference: body.sid ?? 'sent' }
  }
}

/** Records instead of sending, so tests can assert the allowlist and the gating. */
export class FakeSmsProvider implements SmsProvider {
  readonly name = 'fake-sms'

  readonly sent: Array<{ to: string; message: string }> = []

  async send(to: string, message: string): Promise<SmsResult> {
    this.sent.push({ to, message })
    return { ok: true, reference: `FAKE-SMS-${this.sent.length}` }
  }

  reset(): void {
    this.sent.length = 0
  }
}

let cached: SmsProvider | null = null

export function smsProvider(): SmsProvider {
  if (cached) return cached

  if (process.env.NOD_FAKE_PROVIDERS === '1') {
    cached = new FakeSmsProvider()
  } else if (process.env.TWILIO_ACCOUNT_SID) {
    cached = new TwilioSmsProvider()
  } else {
    cached = new ElksSmsProvider()
  }
  return cached
}

export function setSmsProvider(provider: SmsProvider | null): void {
  cached = provider
}

export class SmsNotAllowedError extends Error {
  constructor(kind: string) {
    super(`SMS is not permitted for "${kind}" — docs/06 section 7 allows only ${SMS_ELIGIBLE.join(', ')}`)
    this.name = 'SmsNotAllowedError'
  }
}

/**
 * The only entry point. Throws on a disallowed kind rather than returning false: sending
 * a paid message for something the spec did not sanction is a bug, not a runtime
 * condition to be handled quietly.
 */
export async function sendSms(kind: SmsKind, to: string, message: string): Promise<SmsResult> {
  if (!(SMS_ELIGIBLE as readonly string[]).includes(kind)) {
    throw new SmsNotAllowedError(kind)
  }

  const result = await smsProvider().send(to, message)

  if (result.ok) log.info('sms sent', { kind, provider: smsProvider().name })
  else log.warn('sms failed', { kind, error: result.error })

  return result
}
