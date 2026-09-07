import * as Sentry from '@sentry/nextjs'
import { sharedOptions } from './sentry.shared'

/** Server and edge runtime initialisation — docs/08. */
export function register(): void {
  if (!sharedOptions.dsn) return
  Sentry.init(sharedOptions)
}

export const onRequestError = Sentry.captureRequestError
