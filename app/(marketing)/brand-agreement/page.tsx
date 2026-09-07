import type { Metadata } from 'next'
import { Markdown } from '@/components/Markdown'
import { readSingleLocaleLegal } from '@/lib/legal'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Brand agreement' }

/**
 * The brand-side terms. English only: the brand dashboard and every commercial
 * conversation run in English, and a half-translated contract is worse than one
 * language done properly.
 */
export default async function BrandAgreementPage() {
  const source = await readSingleLocaleLegal('brand-agreement')

  return (
    <article className="section">
      <div className="wrap">
        <Markdown source={source} />
      </div>
    </article>
  )
}
