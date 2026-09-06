import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Meta webhook — docs/06 section 1.
 *
 * NOD reads only; there is no write scope. This endpoint exists for the deauthorize and
 * data-deletion callbacks Meta requires of any app, plus permission changes.
 */
export const runtime = 'nodejs'

/** Meta's subscription handshake. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token && token === process.env.META_APP_SECRET) {
    return new NextResponse(challenge ?? '', { status: 200 })
  }
  return new NextResponse('Forbidden', { status: 403 })
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.META_APP_SECRET
  const signature = request.headers.get('x-hub-signature-256')
  const body = await request.text()

  if (!secret || !signature) return NextResponse.json({ error: 'Not configured' }, { status: 400 })

  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const payload = JSON.parse(body) as { entry?: Array<{ changes?: Array<{ field?: string }> }> }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // A revoked authorisation is handled by the daily token-refresh job, which marks
      // the account DISCONNECTED on the next failed refresh.
      console.info(JSON.stringify({ level: 'info', msg: 'meta webhook', field: change.field }))
    }
  }

  return NextResponse.json({ received: true })
}
