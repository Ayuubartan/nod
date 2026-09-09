/** Every Inngest function, registered on the serve route. */
export * from './timeouts'
export * from './pipeline'
export * from './scheduled'
export * from './training'
export * from './waitlist'
export * from './clips'

import * as timeouts from './timeouts'
import * as pipeline from './pipeline'
import * as scheduled from './scheduled'
import * as training from './training'
import * as waitlist from './waitlist'
import * as clips from './clips'

type InngestFunction = { id?: unknown; createFunction?: unknown }

/** Collects every exported Inngest function so adding one never needs a registry edit. */
export const functions = [timeouts, pipeline, scheduled, training, waitlist, clips].flatMap((mod) =>
  Object.values(mod).filter(
    (value): value is never =>
      typeof value === 'object' && value !== null && 'id' in (value as InngestFunction),
  ),
)
