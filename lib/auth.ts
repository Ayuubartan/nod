/**
 * Auth and role guards — docs/08 "Security baseline": "Role check in every Server
 * Action (requireRole('BRAND', brandId))".
 *
 * Sessions come from one of two places: NOD's own signed cookie, issued by the email
 * code flow (lib/login.ts, lib/session.ts), or Supabase Auth when it is configured for
 * social sign-in. Either way the result is an auth id, which NOD maps onto its own
 * User / BrandUser row — that row is where role and state live.
 */

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createServerClient } from '@supabase/ssr'
import type { Role, User, BrandUser } from '@prisma/client'
import { prisma } from './db'
import { clearSession, readSession } from './session'

export class AuthError extends Error {
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN'

  constructor(code: 'UNAUTHENTICATED' | 'FORBIDDEN', message?: string) {
    super(message ?? code)
    this.name = 'AuthError'
    this.code = code
  }
}

/** Supabase server client bound to the request's cookies. */
export async function supabaseServer() {
  const cookieStore = await cookies()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    throw new AuthError('UNAUTHENTICATED', 'Supabase is not configured')
  }

  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options)
        } catch {
          // Called from a Server Component, where cookies are read-only. The middleware
          // refreshes the session instead.
        }
      },
    },
  })
}

/** Dev-only session cookie, set by /dev. Never consulted in production. */
export const DEV_AUTH_COOKIE = 'NOD_DEV_AUTH'

/** True only outside production. Every dev shortcut in this file is gated on it. */
export function devAuthAllowed(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * The signed-in auth id, or null.
 *
 * Order: dev persona (never in production) → NOD session cookie → Supabase session.
 *
 * Outside production, a `NOD_DEV_AUTH` cookie (set from /dev) or the `NOD_DEV_AUTH_ID`
 * env var stands in for a real sign-in, so the whole product is walkable locally
 * with no provider configured. Both are ignored in production — the guard is the
 * first thing this function checks, so there is no path to them from a real deploy.
 */
export async function currentAuthId(): Promise<string | null> {
  if (devAuthAllowed()) {
    const store = await cookies()
    const fromCookie = store.get(DEV_AUTH_COOKIE)?.value
    if (fromCookie) return fromCookie
    if (process.env.NOD_DEV_AUTH_ID) return process.env.NOD_DEV_AUTH_ID
  }

  const own = await readSession()
  if (own) return own.authId

  try {
    const supabase = await supabaseServer()
    const { data } = await supabase.auth.getUser()
    return data.user?.id ?? null
  } catch {
    return null
  }
}

export type Session =
  | { kind: 'participant'; user: User }
  | { kind: 'brand'; brandUser: BrandUser }
  | { kind: 'ops'; user: User }
  | null

/** Resolves the auth session to a NOD identity. One query, cached per request. */
export async function getSession(): Promise<Session> {
  const authId = await currentAuthId()
  if (!authId) return null

  const user = await prisma.user.findUnique({ where: { authId } })
  if (user && !user.deletedAt) {
    return user.role === 'OPS' ? { kind: 'ops', user } : { kind: 'participant', user }
  }

  const brandUser = await prisma.brandUser.findUnique({ where: { authId } })
  if (brandUser && !brandUser.deletedAt) return { kind: 'brand', brandUser }

  return null
}

/** Participant pages and actions. Redirects to sign-in when there is no session. */
export async function requireParticipant(): Promise<User> {
  const session = await getSession()
  if (!session) redirect('/sign-in')
  if (session.kind === 'brand') redirect('/brand/campaigns')
  return session.user
}

/**
 * Brand pages and actions. When `brandId` is given, the user must belong to that brand —
 * this is what stops one brand reading another's campaign by guessing an id.
 */
export async function requireBrandUser(brandId?: string): Promise<BrandUser> {
  const session = await getSession()
  if (!session) redirect('/brand/sign-in')
  if (session.kind !== 'brand') {
    if (session.kind === 'ops') {
      // Ops can act on any brand; represent that as a synthetic membership.
      return {
        id: `ops:${session.user.id}`,
        brandId: brandId ?? '',
        authId: session.user.authId,
        email: session.user.email ?? 'ops@nod.se',
        name: 'Ops',
        role: 'admin',
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      }
    }
    redirect('/brand/sign-in')
  }
  if (brandId && session.brandUser.brandId !== brandId) {
    throw new AuthError('FORBIDDEN', 'This campaign belongs to another brand')
  }
  return session.brandUser
}

export async function requireOps(): Promise<User> {
  const session = await getSession()
  if (!session) redirect('/sign-in?next=/ops')
  if (session.kind !== 'ops') redirect('/')
  return session.user
}

/**
 * For brand index pages: the brand whose data to show, or null when ops is browsing
 * and should see every brand. Unlike an optional getSession(), there is no way to reach
 * "every brand" without a session — a visitor with none is sent to sign in.
 */
export async function requireBrandScope(): Promise<{ brandId: string | null }> {
  const brandUser = await requireBrandUser()
  return { brandId: brandUser.id.startsWith('ops:') ? null : brandUser.brandId }
}

/**
 * Ends every kind of session at once. The dev persona cookie goes too, so signing out
 * on a dev box behaves like signing out anywhere.
 */
export async function signOutEverywhere(): Promise<void> {
  await clearSession()
  if (devAuthAllowed()) {
    const store = await cookies()
    store.delete(DEV_AUTH_COOKIE)
  }
  try {
    const supabase = await supabaseServer()
    await supabase.auth.signOut()
  } catch {
    // Not configured, or no Supabase session — nothing to end there.
  }
}

/** Generic guard used by Server Actions that are not tied to a route group. */
export async function requireRole(role: Role, brandId?: string): Promise<Session> {
  const session = await getSession()
  if (!session) throw new AuthError('UNAUTHENTICATED')

  if (role === 'OPS' && session.kind !== 'ops') throw new AuthError('FORBIDDEN')
  if (role === 'PARTICIPANT' && session.kind !== 'participant') throw new AuthError('FORBIDDEN')
  if (role === 'BRAND') {
    if (session.kind === 'ops') return session
    if (session.kind !== 'brand') throw new AuthError('FORBIDDEN')
    if (brandId && session.brandUser.brandId !== brandId) throw new AuthError('FORBIDDEN')
  }
  return session
}

/** The actor to record on a transition, derived from the session. */
export function actorFor(session: NonNullable<Session>) {
  if (session.kind === 'ops') return { kind: 'OPS' as const, id: session.user.id }
  if (session.kind === 'brand') return { kind: 'BRAND' as const, id: session.brandUser.id }
  return { kind: 'PARTICIPANT' as const, id: session.user.id }
}
