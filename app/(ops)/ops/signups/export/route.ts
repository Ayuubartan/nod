import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { actorString } from '@/lib/state/transition'
import { enquiriesCsv, exportFilename, isExportKind, waitlistCsv } from '@/lib/signups-export'

/**
 * `/ops/signups/export?kind=waitlist|enquiries` — the whole list as a CSV download.
 *
 * A route handler rather than a Server Action because a download is a navigation, and
 * because the (ops) layout guard does not run for handlers — so `requireOps` is called
 * here explicitly. Personal data leaves the system on this path; each call writes one
 * AuditLog row naming the ops user, the kind and the row count.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const ops = await requireOps()
  const kind = new URL(request.url).searchParams.get('kind')
  if (!isExportKind(kind)) return NextResponse.json({ error: 'kind must be waitlist or enquiries' }, { status: 400 })

  let body: string
  let count: number
  if (kind === 'waitlist') {
    const rows = await prisma.waitlistEntry.findMany({ where: { deletedAt: null }, orderBy: { position: 'asc' } })
    body = waitlistCsv(rows)
    count = rows.length
  } else {
    const rows = await prisma.brandEnquiry.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } })
    body = enquiriesCsv(rows)
    count = rows.length
  }

  await prisma.auditLog.create({
    data: {
      entity: kind === 'waitlist' ? 'WaitlistEntry' : 'BrandEnquiry',
      entityId: '*',
      event: 'EXPORT',
      actor: actorString({ kind: 'OPS', id: ops.id }),
      payload: { kind, count },
    },
  })

  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFilename(kind)}"`,
      'cache-control': 'no-store',
    },
  })
}
