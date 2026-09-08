import type { Metadata, Viewport } from 'next'
import { BRAND } from '@/lib/brand'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { Inter, JetBrains_Mono, Permanent_Marker, Space_Grotesk } from 'next/font/google'
import './globals.css'

// Space Grotesk carries headings, buttons and the wordmark; Inter the body; Permanent
// Marker the handwritten notes (docs/10). JetBrains Mono stays for amounts and IDs.
const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-space', weight: ['500', '700'] })
const body = Inter({ subsets: ['latin'], variable: '--font-inter' })
const marker = Permanent_Marker({ subsets: ['latin'], variable: '--font-marker-face', weight: '400' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', weight: ['400', '600'] })

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: `${BRAND} — Du postar. Varumärken betalar.`, template: `%s · ${BRAND}` },
  description:
    'Få betalt för innehållet du redan postar. Varumärken betalar för att synas naturligt i dina bilder och stories — du väljer, du godkänner, du postar själv.',
  openGraph: { type: 'website', siteName: BRAND, locale: 'sv_SE' },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F1EA' },
    { media: '(prefers-color-scheme: dark)', color: '#111820' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  const messages = await getMessages()

  return (
    <html lang={locale} className={`${display.variable} ${body.variable} ${marker.variable} ${mono.variable}`}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
