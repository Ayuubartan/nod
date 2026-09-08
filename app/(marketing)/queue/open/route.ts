import { NextResponse } from 'next/server'
import { markEmailVerified } from '@/lib/queue'
import { decodeQueueToken, queueCookie } from '@/lib/queue-session'

export const runtime = 'nodejs'

/**
 * Opens a queue link (docs/13). The token in ?t= names the entry; a valid one sets
 * the NOD_QUEUE cookie and, when it arrived by mail, proves the address. Either way
 * the browser lands on /queue: a stale or forged token just shows the "email me my
 * link" form, never an error.
 *
 * This is a route handler because a Server Component may not write cookies.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const decoded = decodeQueueToken(url.searchParams.get('t'))
  const response = NextResponse.redirect(new URL('/queue', url.origin), 302)
  if (decoded) {
    if (decoded.via === 'email') await markEmailVerified(decoded.entryId)
    const cookie = queueCookie(decoded.entryId)
    response.cookies.set(cookie.name, cookie.value, cookie.options)
  }
  return response
}
