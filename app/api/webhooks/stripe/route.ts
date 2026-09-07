import { NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { prisma } from '@/lib/db'
import { log } from '@/lib/logger'
import { stripe } from '@/lib/integrations/stripe'
import { alreadyPosted } from '@/lib/money/ledger'
import { fund } from '@/lib/state/campaign'
import { SYSTEM } from '@/lib/state/transition'

/**
 * Stripe webhook — docs/06 section 4.
 *
 * The signature is verified on every request, and the payment intent id is used as the
 * ledger's externalRef, so a redelivered event cannot fund a campaign twice
 * (docs/08 "Webhook signature verification on every inbound webhook; idempotency by
 * external ID").
 */
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('stripe-signature')
  const secret = process.env.STRIPE_WEBHOOK_SECRET

  if (!signature || !secret) {
    return NextResponse.json({ error: 'Not configured' }, { status: 400 })
  }

  const body = await request.text()

  let event: Stripe.Event
  try {
    event = stripe().webhooks.constructEvent(body, signature, secret)
  } catch (error) {
    log.error('stripe signature verification failed', error)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const campaignId = session.metadata?.campaignId
        if (!campaignId) break

        const paymentRef =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session.payment_intent?.id ?? session.id)

        // Idempotency: the ledger's unique externalRef is the real guard, but checking
        // first keeps a replay from throwing.
        if (await alreadyPosted(prisma, paymentRef)) break

        const campaign = await prisma.campaign.findUnique({
          where: { id: campaignId },
          select: { state: true, budget: true },
        })
        if (!campaign || campaign.state !== 'AWAITING_FUNDS') break

        // Fund with the campaign budget, not the charged total: the credit-terms fee is
        // NOD revenue and is posted separately, never as available campaign budget.
        await fund(campaignId, { amountOre: campaign.budget, externalRef: paymentRef, via: 'card' }, SYSTEM)
        break
      }

      case 'charge.refunded':
      case 'payment_intent.payment_failed': {
        log.info('stripe event', { type: event.type, eventId: event.id })
        break
      }

      default:
        break
    }
  } catch (error) {
    log.error('stripe webhook handler failed', error, { type: event.type, eventId: event.id })
    // 500 makes Stripe retry, which is what we want for a transient database failure.
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
