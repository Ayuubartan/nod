'use server'

import { getLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import type { Locale } from '@/lib/i18n/config'
import { requestCode, safeNext, verifyCode, type RequestResult, type VerifyResult } from '@/lib/login'
import { setSession } from '@/lib/session'
import { signOutEverywhere } from '@/lib/auth'

const audienceSchema = z.enum(['PARTICIPANT', 'BRAND'])
const requestSchema = z.object({ email: z.string().max(254), audience: audienceSchema })
const verifySchema = z.object({
  email: z.string().max(254),
  code: z.string().max(12),
  audience: audienceSchema,
  next: z.string().max(300).optional().nullable(),
})

export async function requestLoginCode(input: unknown): Promise<RequestResult> {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'invalidEmail' }
  const locale = (await getLocale()) as Locale
  return requestCode(parsed.data.email, parsed.data.audience, locale)
}

/** On success the session cookie is set and the caller is redirected; errors are returned. */
export async function verifyLoginCode(input: unknown): Promise<Extract<VerifyResult, { ok: false }>> {
  const parsed = verifySchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'wrongCode' }

  const result = await verifyCode(parsed.data.email, parsed.data.code, parsed.data.audience)
  if (!result.ok) return result

  await setSession(result.authId, result.email)
  // A requested destination wins only when it is one of ours; a brand user is never
  // sent into the participant app this way, because those routes redirect them back.
  redirect(safeNext(parsed.data.next, result.next))
}

export async function signOut(): Promise<void> {
  await signOutEverywhere()
  redirect('/')
}
