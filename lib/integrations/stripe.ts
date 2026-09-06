/**
 * Brand deposits — docs/06 section 4.
 *
 * Card: Stripe Checkout, one payment for the campaign budget. The webhook writes the
 * DEPOSIT ledger entry and moves the campaign to FUNDED. Invoice (net-30) is ops
 * approved and adds a CREDIT_TERMS_FEE entry.
 *
 * Deposits are client funds and must sit in a bank account separate from operating
 * cash (docs/06 section 4, docs/07 section 5 [ACCOUNTANT]).
 */

import Stripe from 'stripe'
import type { DepositProvider } from './types'

let client: Stripe | null = null

export function stripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
    client = new Stripe(key)
  }
  return client
}

export class StripeDepositProvider implements DepositProvider {
  readonly name = 'stripe'

  async createCheckout(args: {
    campaignId: string
    amountOre: number
    brandEmail: string
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string; sessionId: string }> {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      customer_email: args.brandEmail,
      // Stripe's smallest unit for SEK is öre, which is exactly how NOD stores money.
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'sek',
            unit_amount: args.amountOre,
            product_data: { name: `NOD campaign budget (${args.campaignId})` },
          },
        },
      ],
      // The webhook is the source of truth; the client never confirms funding.
      metadata: { campaignId: args.campaignId },
      payment_intent_data: { metadata: { campaignId: args.campaignId } },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    })

    if (!session.url) throw new Error('Stripe did not return a checkout URL')
    return { url: session.url, sessionId: session.id }
  }

  async refund(args: { paymentRef: string; amountOre: number }): Promise<{ reference: string }> {
    const refund = await stripe().refunds.create({
      payment_intent: args.paymentRef,
      amount: args.amountOre,
    })
    return { reference: refund.id }
  }
}

/** Local/test double: returns a URL that lands straight on the success page. */
export class FakeDepositProvider implements DepositProvider {
  readonly name = 'fake-stripe'

  async createCheckout(args: {
    campaignId: string
    amountOre: number
    successUrl: string
  }): Promise<{ url: string; sessionId: string }> {
    const sessionId = `cs_fake_${args.campaignId}`
    return { url: `${args.successUrl}?session_id=${sessionId}&fake=1`, sessionId }
  }

  async refund(args: { paymentRef: string }): Promise<{ reference: string }> {
    return { reference: `re_fake_${args.paymentRef}` }
  }
}

const shouldUseFakes = () => process.env.NOD_FAKE_PROVIDERS === '1' || !process.env.STRIPE_SECRET_KEY

let cached: DepositProvider | null = null

export function depositProvider(): DepositProvider {
  if (cached) return cached
  cached = shouldUseFakes() ? new FakeDepositProvider() : new StripeDepositProvider()
  return cached
}

export function setDepositProvider(provider: DepositProvider | null): void {
  cached = provider
}
