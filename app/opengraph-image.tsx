import { ImageResponse } from 'next/og'
import { WORDMARK } from '@/lib/brand'
import { ogFonts } from '@/lib/og-font'

/**
 * Link preview for the site: the hero line on paper (docs/10 "WHO CAN BOOGAA ME?").
 * Set in Space Grotesk 700 when the font can be fetched (lib/og-font).
 */
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export const alt = 'Boogaa — who can Boogaa me?'

export default async function OpenGraphImage() {
  const fonts = await ogFonts()
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#F4F1EA',
          color: '#111820',
          padding: 72,
          fontFamily: 'Space Grotesk, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <svg viewBox="0 0 100 100" width="72" height="72">
            <path d="M50 50 L96.98 32.9 A50 50 0 1 0 96.98 67.1 Z" fill="#20C5C7" />
            <path d="M58 18 L30 56 L47 56 L40 84 L70 42 L53 42 Z" fill="#FF7417" />
          </svg>
          <div style={{ display: 'flex', fontSize: 52, fontWeight: 800, letterSpacing: -3 }}>{WORDMARK}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', fontSize: 112, fontWeight: 800, letterSpacing: -5, lineHeight: 1 }}>
            WHO CAN
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            <div
              style={{
                display: 'flex',
                fontSize: 112,
                fontWeight: 800,
                letterSpacing: -5,
                lineHeight: 1,
                background: '#20C5C7',
                padding: '0 18px',
                borderBottom: '14px solid #FF7417',
              }}
            >
              BOOGAA
            </div>
            <div style={{ display: 'flex', fontSize: 112, fontWeight: 800, letterSpacing: -5, lineHeight: 1 }}>
              ME?
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', fontSize: 30, color: '#4B5560' }}>
          Get paid for the content you already post. · joinbooga.se
        </div>
      </div>
    ),
    { ...size, ...fonts },
  )
}
