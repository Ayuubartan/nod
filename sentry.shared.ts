/**
 * Sentry configuration shared by the server, edge and client runtimes.
 *
 * docs/08 security baseline: "Sentry scrubbing configured before first deploy."
 * docs/06 section 8: "scrub swishNumber, tokens, any BankID payload."
 *
 * `beforeSend` runs the whole event through lib/scrub.ts — the same function the logger
 * uses — so an identity number cannot reach Sentry via a stack frame's local variables,
 * a breadcrumb, a request body or a URL query string. Anything that fails to scrub is
 * dropped rather than sent.
 */

import type { Breadcrumb, ErrorEvent, EventHint } from '@sentry/nextjs'
import { scrubUrl, scrubValue } from '@/lib/scrub'

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN

export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  try {
    const scrubbed = scrubValue(event) as ErrorEvent

    if (scrubbed.request?.url) scrubbed.request.url = scrubUrl(scrubbed.request.url)

    // Cookies and headers can carry a session or a broker callback; never send them.
    if (scrubbed.request) {
      delete scrubbed.request.cookies
      delete scrubbed.request.headers
      delete scrubbed.request.data
    }

    // A user's id is enough to debug with; an email or an IP is not ours to ship.
    if (scrubbed.user) {
      scrubbed.user = { id: scrubbed.user.id }
    }

    return scrubbed
  } catch {
    // If scrubbing itself fails, drop the event. Losing a stack trace is recoverable;
    // sending a personnummer to a third party is not.
    return null
  }
}

export const sharedOptions = {
  dsn: SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
  enabled: Boolean(SENTRY_DSN),
  // RED metrics on Server Actions come from lib/logger.ts; Sentry samples traces for
  // the slow-path detail rather than carrying every request.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 0,
  sendDefaultPii: false,
  beforeSend: scrubEvent,
  beforeBreadcrumb: (breadcrumb: Breadcrumb): Breadcrumb | null => scrubValue(breadcrumb),
  ignoreErrors: [
    // Next.js control-flow signals, not failures.
    'NEXT_REDIRECT',
    'NEXT_NOT_FOUND',
  ],
}
