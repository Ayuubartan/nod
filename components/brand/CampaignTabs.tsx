import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

export type CampaignTab = 'overview' | 'creative' | 'review' | 'report' | 'edit'

/** Sub-navigation for one campaign. The review tab carries its count so nothing waits unseen. */
export async function CampaignTabs({
  campaignId,
  active,
  reviewCount = 0,
  showReport = false,
}: {
  campaignId: string
  active: CampaignTab
  reviewCount?: number
  showReport?: boolean
}) {
  const t = await getTranslations('brandApp')
  const base = `/brand/campaigns/${campaignId}`
  const tabs: { key: CampaignTab; href: string; label: string; badge?: number }[] = [
    { key: 'overview', href: base, label: t('overview') },
    { key: 'creative', href: `${base}/assets`, label: t('creative') },
    { key: 'review', href: `${base}/review`, label: t('reviewQueue'), badge: reviewCount },
    ...(showReport ? [{ key: 'report' as const, href: `${base}/report`, label: t('report') }] : []),
    { key: 'edit', href: `${base}/edit`, label: t('edit') },
  ]

  return (
    <nav className="flex gap-1 border-b border-[var(--color-line)] mb-6 overflow-x-auto" aria-label="campaign">
      {tabs.map((tab) => {
        const isActive = tab.key === active
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={isActive ? 'page' : undefined}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
              isActive
                ? 'border-[var(--color-blue)] font-semibold'
                : 'border-transparent text-[var(--color-ink-2)] hover:text-[var(--color-ink)]'
            }`}
          >
            {tab.label}
            {tab.badge ? (
              <span className="ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 min-w-5 h-5 text-[11px] font-semibold bg-[var(--color-amber)] text-[#14110F]">
                {tab.badge}
              </span>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
