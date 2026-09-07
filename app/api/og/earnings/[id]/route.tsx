import { ImageResponse } from 'next/og'
import { BRAND } from '@/lib/brand'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { formatKrDown } from '@/lib/money/calc'

/**
 * The shareable earnings card — docs/10-brand.md:
 * "white card, amber amount in Outfit 800, 'via NOD' small, participant's chosen emoji,
 *  no brand logo unless the brand opts in. Must look good as an Instagram Story at
 *  1080x1920."
 *
 * The amount comes from the PAYOUT_ACCRUE ledger entry — what was actually paid, never
 * an estimate.
 */
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params

  const session = await getSession()
  if (!session || session.kind === 'brand') return new Response('Unauthorized', { status: 401 })

  const placement = await prisma.placement.findFirst({
    where: {
      id,
      ...(session.kind === 'participant' ? { userId: session.user.id } : {}),
      state: { in: ['QUALIFIED', 'PAID'] },
    },
    select: { id: true, verification: { select: { qualifiedViews: true } } },
  })
  if (!placement) return new Response('Not found', { status: 404 })

  const accrued = await prisma.ledgerEntry.aggregate({
    where: { placementId: placement.id, type: 'PAYOUT_ACCRUE' },
    _sum: { amountOre: true },
  })
  const amount = formatKrDown(accrued._sum.amountOre ?? 0)
  const views = placement.verification?.qualifiedViews ?? 0

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FAF7F2',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            background: '#FFFFFF',
            border: '2px solid #E8E2DA',
            borderRadius: 48,
            padding: '96px 72px',
            width: 820,
          }}
        >
          <div style={{ display: 'flex', fontSize: 72, marginBottom: 32 }}>☕</div>

          <div style={{ display: 'flex', fontSize: 160, fontWeight: 800, color: '#F5A524', letterSpacing: -6 }}>
            +{amount}
          </div>

          <div style={{ display: 'flex', fontSize: 40, color: '#5C554D', marginTop: 24 }}>
            {views.toLocaleString('sv-SE')} visningar
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginTop: 72,
              paddingTop: 40,
              borderTop: '2px solid #E8E2DA',
              width: '100%',
              justifyContent: 'center',
            }}
          >
            <div style={{ display: 'flex', width: 28, height: 28, borderRadius: 999, background: '#F5A524' }} />
            <div style={{ display: 'flex', fontSize: 32, color: '#A39B91' }}>via {BRAND}</div>
          </div>
        </div>
      </div>
    ),
    { width: 1080, height: 1920 },
  )
}
