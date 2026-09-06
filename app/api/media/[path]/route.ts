import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { get } from '@/lib/storage'

/**
 * Authorised media proxy. A participant's original photo is unpublished personal
 * content, so every read is checked against who is asking:
 *   - the participant who owns the placement
 *   - a brand user, but only for a placement on one of their own campaigns
 *   - ops
 */
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string }> },
): Promise<Response> {
  const session = await getSession()
  if (!session) return new NextResponse('Unauthorized', { status: 401 })

  const { path: encoded } = await params
  const path = decodeURIComponent(encoded)

  if (path.includes('..')) return new NextResponse('Bad request', { status: 400 })

  if (!(await canRead(session, path))) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  try {
    const body = await get(path)
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'content-type': contentTypeFor(path),
        'cache-control': 'private, max-age=300',
      },
    })
  } catch {
    return new NextResponse('Not found', { status: 404 })
  }
}

async function canRead(
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  path: string,
): Promise<boolean> {
  if (session.kind === 'ops') return true

  // Campaign assets are brand material and are readable by anyone signed in — a
  // participant has to see the product before deciding to place it.
  if (path.startsWith('assets/')) return true

  const placementId = path.split('/')[1]?.split('.')[0]
  if (!placementId) return false

  const placement = await prisma.placement.findUnique({
    where: { id: placementId },
    select: { userId: true, campaign: { select: { brandId: true } } },
  })
  if (!placement) return false

  if (session.kind === 'participant') return placement.userId === session.user.id
  return placement.campaign.brandId === session.brandUser.brandId
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.pdf')) return 'application/pdf'
  if (path.endsWith('.json')) return 'application/json'
  return 'image/jpeg'
}
