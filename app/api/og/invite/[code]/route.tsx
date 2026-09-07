import { ImageResponse } from 'next/og'
import { BRAND } from '@/lib/brand'
import { prisma } from '@/lib/db'

/**
 * Per-referral share image — docs/01: "OG image generated per referral link
 * ('Anna invited you to NOD')", and the Story share on the waitlist success screen.
 *
 * Sized 1080x1920 so it can be posted straight to an Instagram Story.
 * ?og=1 returns the 1200x630 link-preview size instead.
 */
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params
  const isOg = new URL(request.url).searchParams.get('og') === '1'

  const entry = await prisma.waitlistEntry
    .findUnique({ where: { referralCode: code.toUpperCase() }, select: { handle: true } })
    .catch(() => null)

  const width = isOg ? 1200 : 1080
  const height = isOg ? 630 : 1920
  const invitedBy = entry?.handle ? `@${entry.handle}` : null

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          background: '#FAF7F2',
          padding: isOg ? 64 : 96,
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: 96,
            height: 96,
            borderRadius: 999,
            background: '#F5A524',
            marginBottom: 48,
          }}
        />
        <div
          style={{
            display: 'flex',
            fontSize: isOg ? 34 : 44,
            color: '#5C554D',
            marginBottom: 16,
            textAlign: 'center',
          }}
        >
          {invitedBy ? `${invitedBy} bjöd in dig till` : 'Du är inbjuden till'}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: isOg ? 128 : 180,
            fontWeight: 800,
            color: '#14110F',
            letterSpacing: -6,
          }}
        >
          {BRAND}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: isOg ? 32 : 44,
            color: '#5C554D',
            marginTop: 24,
            textAlign: 'center',
            maxWidth: isOg ? 900 : 820,
          }}
        >
          Posta som vanligt. Få betalt för visningarna.
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: isOg ? 48 : 96,
            padding: '20px 40px',
            borderRadius: 999,
            background: '#FFFFFF',
            border: '2px solid #E8E2DA',
            fontSize: isOg ? 30 : 42,
            color: '#14110F',
            letterSpacing: 4,
          }}
        >
          {code.toUpperCase()}
        </div>
      </div>
    ),
    { width, height },
  )
}
