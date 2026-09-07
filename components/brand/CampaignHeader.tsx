import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import type { Campaign } from '@prisma/client'
import { CampaignStateChip } from './CampaignStateChip'
import { FundButton } from './FundButton'

/**
 * Title block for every campaign page. One line under the name says what happens next
 * for the campaign's current state — the question a brand actually opens the page with.
 */
export async function CampaignHeader({
  campaign,
  brandName,
  actions,
}: {
  campaign: Pick<Campaign, 'id' | 'name' | 'state' | 'startsAt' | 'endsAt'>
  brandName: string
  actions?: React.ReactNode
}) {
  const t = await getTranslations('brandApp')

  return (
    <header className="flex flex-wrap items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <Link href="/brand/campaigns" className="text-xs text-[var(--color-ink-3)] hover:underline">
          ← {t('backToCampaigns')}
        </Link>
        <p className="text-sm text-[var(--color-ink-2)] mt-1">{brandName}</p>
        <h1 className="text-2xl truncate">{campaign.name}</h1>
        <p className="text-sm text-[var(--color-ink-2)] mt-1">{t(`nextStep.${campaign.state}`)}</p>
        {campaign.startsAt && campaign.endsAt && (
          <p className="text-xs text-[var(--color-ink-3)] tabular mt-1">
            {campaign.startsAt.toLocaleDateString('sv-SE')} – {campaign.endsAt.toLocaleDateString('sv-SE')}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        <CampaignStateChip state={campaign.state} />
        {campaign.state === 'AWAITING_FUNDS' && <FundButton campaignId={campaign.id} />}
        {actions}
      </div>
    </header>
  )
}
