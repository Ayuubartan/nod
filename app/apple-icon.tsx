import { ImageResponse } from 'next/og'

/** Home-screen icon: the symbol on paper with a little room around it. */
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F4F1EA',
        }}
      >
        <svg viewBox="0 0 100 100" width="136" height="136">
          <path d="M50 50 L96.98 32.9 A50 50 0 1 0 96.98 67.1 Z" fill="#20C5C7" />
          <path d="M58 18 L30 56 L47 56 L40 84 L70 42 L53 42 Z" fill="#FF7417" />
        </svg>
      </div>
    ),
    size,
  )
}
