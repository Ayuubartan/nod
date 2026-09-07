import type { Metadata, Viewport } from 'next'
import { BRAND } from '@/lib/brand'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import { Outfit, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const display = Outfit({ subsets: ['latin'], variable: '--font-outfit', weight: ['600', '700', '800'] })
const body = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', weight: ['400', '600'] })

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: `${BRAND} — Posta som vanligt`, template: `%s · ${BRAND}` },
  description:
    'Brands betalar för att synas naturligt i dina bilder och stories. Du väljer brand, du väljer var, du godkänner allt.',
  openGraph: { type: 'website', siteName: BRAND, locale: 'sv_SE' },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAF7F2' },
    { media: '(prefers-color-scheme: dark)', color: '#14110F' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale()
  const messages = await getMessages()

  return (
    <html lang={locale} className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
