import * as Sentry from '@sentry/nextjs'
import { sharedOptions } from './sentry.shared'

/** Browser initialisation. The same scrubber runs here (docs/08). */
if (sharedOptions.dsn) {
  Sentry.init({
    ...sharedOptions,
    // Session replay is deliberately off: participants upload personal photos and the
    // ops console shows verification screenshots. Neither belongs in a replay.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  })
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
