import { getTranslations } from 'next-intl/server'
import type { Campaign, SubmissionState } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { CampaignBalance } from '@/lib/money/balances'
import { effectiveCpmOre, formatKrDown, formatOre } from '@/lib/money/calc'
import { SubmissionStateChip } from '@/components/participant/SubmissionStateChip'

const STATE_ORDER: SubmissionState[] = ['RECEIVED', 'FIX_DISCLOSURE', 'TRACKING', 'VALIDATING', 'HELD', 'QUALIFIED', 'PAID', 'REJECTED']
const PLATFORM_LABEL = { TIKTOK: 'TikTok', INSTAGRAM: 'Instagram' } as const

/**
 * Clip campaign dashboard body — docs/14. Members, clips by state, counted views and
 * the clips themselves. The brand sees handles and public post links, never contact or
 * identity data (docs/07 §3). Views are the last provider pull per row, nothing modelled.
 */
export async function ClipOverview({
  campaign,
  balance,
}: {
  campaign: Pick<Campaign, 'id' | 'platforms' | 'requiredHashtags' | 'requiredMentions' | 'validationHours' | 'perPersonCap'>
  balance: CampaignBalance
}) {
  const t = await getTranslations('brandApp')

  const [members, submissions] = await Promise.all([
    prisma.campaignMembership.count({ where: { campaignId: campaign.id, state: 'JOINED', deletedAt: null } }),
    prisma.submission.findMany({
      where: { campaignId: campaign.id, deletedAt: null },
      select: {
        id: true,
        state: true,
        platform: true,
        canonicalUrl: true,
        submittedAt: true,
        latestViews: true,
        eligibleViews: true,
        reservationOre: true,
        budgetExhausted: true,
        account: { select: { handle: true } },
      },
      orderBy: { submittedAt: 'desc' },
      take: 500,
    }),
  ])

  const byState = new Map<SubmissionState, number>()
  for (const s of submissions) byState.set(s.state, (byState.get(s.state) ?? 0) + 1)
  const settled = submissions.filter((s) => s.state === 'QUALIFIED' || s.state === 'PAID')
  const countedViews = settled.reduce((sum, s) => sum + s.eligibleViews, 0)
  const trackingNow = (byState.get('TRACKING') ?? 0) + (byState.get('VALIDATING') ?? 0)
  const held = byState.get('HELD') ?? 0
  const nf = (n: number) => n.toLocaleString('sv-SE')

  const kpis = [
    { label: t('clip.members'), value: nf(members) },
    { label: t('clip.submissions'), value: nf(submissions.length) },
    { label: t('clip.eligibleViews'), value: nf(countedViews) },
    { label: t('effectiveCpm'), value: formatKrDown(effectiveCpmOre(balance.spentOre, countedViews)) },
  ]

  return (
    <>
      <ul className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-6">
        {kpis.map((kpi) => (
          <li key={kpi.label} className="card p-4">
            <p className="text-xs text-[var(--color-ink-2)] mb-1">{kpi.label}</p>
            <p className="amount text-xl font-semibold">{kpi.value}</p>
          </li>
        ))}
      </ul>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr] mb-8">
        <section>
          <h2 className="label">{t('clip.byState')}</h2>
          <ul className="card p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            {STATE_ORDER.map((state) => (
              <li key={state} className="flex items-center justify-between gap-2 px-1">
                <SubmissionStateChip state={state} />
                <span className="tabular font-semibold">{nf(byState.get(state) ?? 0)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-[var(--color-ink-3)] mt-2 tabular">
            {t('clip.tracking')}: {nf(trackingNow)} · {t('clip.awaitingReview')}: {nf(held)}
          </p>
        </section>

        <section>
          <h2 className="label">{t('clip.rules')}</h2>
          <dl className="card p-3 text-sm grid gap-1.5">
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-ink-2)]">{t('clip.platforms')}</dt>
              <dd>{campaign.platforms.map((p) => PLATFORM_LABEL[p]).join(' / ')}</dd>
            </div>
            {campaign.requiredHashtags.length > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-ink-2)]">{t('clip.hashtags')}</dt>
                <dd className="tabular text-right">{campaign.requiredHashtags.join(' ')}</dd>
              </div>
            )}
            {campaign.requiredMentions.length > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-ink-2)]">{t('clip.mentions')}</dt>
                <dd className="tabular text-right">{campaign.requiredMentions.join(' ')}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--color-ink-2)]">{t('clip.validationDays', { days: Math.round(campaign.validationHours / 24) })}</dt>
              <dd>{t('clip.capPerPerson', { count: campaign.perPersonCap })}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section>
        <h2 className="label">{t('clip.submissions')}</h2>
        <div className="overflow-x-auto card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-line)]">
                <th className="text-left font-semibold px-3 py-3">{t('clip.table.handle')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('clip.table.platform')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('clip.table.submitted')}</th>
                <th className="text-right font-semibold px-3 py-3">{t('clip.table.views')}</th>
                <th className="text-right font-semibold px-3 py-3">{t('clip.table.eligible')}</th>
                <th className="text-right font-semibold px-3 py-3">{t('clip.table.reserved')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('clip.table.state')}</th>
                <th className="text-left font-semibold px-3 py-3">{t('clip.table.post')}</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id} className="border-b border-[var(--color-line)] last:border-0">
                  <td className="px-3 py-2">@{s.account.handle}</td>
                  <td className="px-3 py-2 text-[var(--color-ink-2)]">{PLATFORM_LABEL[s.platform]}</td>
                  <td className="px-3 py-2 text-[var(--color-ink-2)] tabular">{s.submittedAt.toLocaleDateString('sv-SE')}</td>
                  <td className="px-3 py-2 text-right tabular">{s.latestViews === null ? '—' : nf(s.latestViews)}</td>
                  <td className="px-3 py-2 text-right tabular font-semibold">{nf(s.eligibleViews)}</td>
                  <td className="px-3 py-2 text-right tabular">
                    {s.budgetExhausted ? <span className="text-[var(--color-ink-3)]">0 kr</span> : formatOre(s.reservationOre)}
                  </td>
                  <td className="px-3 py-2">
                    <SubmissionStateChip state={s.state} />
                  </td>
                  <td className="px-3 py-2">
                    <a href={s.canonicalUrl} target="_blank" rel="noreferrer noopener" className="underline text-[var(--color-blue)]">
                      ↗
                    </a>
                  </td>
                </tr>
              ))}
              {submissions.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-[var(--color-ink-3)]">
                    {t('clip.table.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
