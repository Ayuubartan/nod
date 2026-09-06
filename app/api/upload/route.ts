import { NextResponse } from 'next/server'
import { requireParticipant } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { extensionFor, paths, put } from '@/lib/storage'
import { preCheck } from '@/lib/media'
import { submitUpload } from '@/app/(participant)/actions'
import { rateLimit } from '@/lib/rate-limit'

/**
 * P-02 upload. The perceptual hash is computed HERE, server-side, so the duplicate
 * check in `upload()` cannot be defeated by a client sending a made-up hash.
 */
export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(request: Request): Promise<Response> {
  const user = await requireParticipant()

  if (!(await rateLimit(`upload:${user.id}`, 20, 60_000))) {
    return NextResponse.json({ ok: false, error: 'rateLimited' }, { status: 429 })
  }

  const form = await request.formData()
  const file = form.get('file')
  const placementId = String(form.get('placementId') ?? '')
  const contentType = String(form.get('contentType') ?? 'story')

  if (!(file instanceof File) || !placementId) {
    return NextResponse.json({ ok: false, error: 'format' }, { status: 400 })
  }

  const placement = await prisma.placement.findFirst({
    where: { id: placementId, userId: user.id, state: 'CLAIMED' },
    select: { id: true },
  })
  if (!placement) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const checked = await preCheck({ mimeType: file.type, bytes: buffer.byteLength, buffer })
  if (!checked.ok) {
    return NextResponse.json({ ok: false, error: checked.error }, { status: 400 })
  }

  const storagePath = paths.original(placementId, extensionFor(file.type))
  await put(storagePath, buffer, file.type)

  const result = await submitUpload({
    placementId,
    storagePath,
    perceptualHash: checked.hash,
    contentType: contentType === 'reel' || contentType === 'post' ? contentType : 'story',
  })

  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
