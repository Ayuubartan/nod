import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { Markdown } from '@/components/Markdown'
import { readLegal } from '@/lib/legal'
import type { Locale } from '@/lib/i18n/config'

// The Markdown source is chosen by locale, so this varies by cookie too.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('legal')
  return { title: t('privacyTitle') }
}

export default async function PrivacyPage() {
  const locale = (await getLocale()) as Locale
  const t = await getTranslations('legal')
  const source = await readLegal('privacy', locale)

  return (
    <article className="section">
      <div className="wrap">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-red)] mb-6">
          {t('draftNotice')}
        </p>
        <Markdown source={source} />
      </div>
    </article>
  )
}
