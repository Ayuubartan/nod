import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { log } from '@/lib/logger'
import { handleInboundSms } from '@/lib/waitlist-sms'

/**
 * Inbound SMS — the STOP path of docs/13 ("make opt-out straightforward").
 *
 * 46elks posts `from` and `message` as a form body to the URL configured on the
 * number. The URL carries `?key=SMS_WEBHOOK_SECRET`, compared in constant time; with
 * no secret configured the route refuses everything rather than trusting the world.
 * Replies are never sent from here — an empty 200 is what 46elks wants, and the
 * person already knows what STOP does.
 */
export const runtime = 'nodejs'

function authorised(request: Request): boolean {
  const secret = process.env.SMS_WEBHOOK_SECRET
  if (!secret) return false
  const key = new URL(request.url).searchParams.get('key') ?? ''
  const a = Buffer.from(key)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  let from = ''
  let message = ''
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    from = String(body.from ?? '')
    message = String(body.message ?? '')
  } else {
    const form = await request.formData().catch(() => null)
    from = String(form?.get('from') ?? '')
    message = String(form?.get('message') ?? '')
  }
  if (!from) return NextResponse.json({ error: 'Missing from' }, { status: 400 })

  const optedOut = await handleInboundSms(from, message)
  if (optedOut) log.info('sms opt-out', { count: optedOut })
  return new Response('', { status: 200 })
}
