import { serve } from 'inngest/next'
import { inngest } from '@/lib/events'
import { functions } from '@/inngest'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
  signingKey: process.env.INNGEST_SIGNING_KEY,
})
