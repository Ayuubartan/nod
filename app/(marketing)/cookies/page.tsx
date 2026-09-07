import type { Metadata } from 'next'
import { getLocale } from 'next-intl/server'
import { Markdown } from '@/components/Markdown'
import { readLegal } from '@/lib/legal'
import type { Locale } from '@/lib/i18n/config'

// Varies by the locale cookie, like the other legal pages.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Cookies' }

export default async function CookiesPage() {
  const locale = (await getLocale()) as Locale
  const source = await readLegal('cookies', locale)

  return (
    <article className="section">
      <div className="wrap">
        <Markdown source={source} />
      </div>
    </article>
  )
}
