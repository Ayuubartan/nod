import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireBrandUser } from '@/lib/auth'
import { renderReport } from '@/lib/report'

/** The final PDF report — docs/02 B2. Generated on demand from the ledger. */
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params

  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { brandId: true, name: true },
  })
  if (!campaign) return new NextResponse('Not found', { status: 404 })

  await requireBrandUser(campaign.brandId)

  const pdf = await renderReport(id)
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="nod-report-${id}.pdf"`,
    },
  })
}
