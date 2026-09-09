import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import type { Campaign, PayoutTemplate, SocialAccount, User } from '@prisma/client'
import { prisma } from '@/lib/db'
import { campaignBalance } from '@/lib/money/balances'
import { formatKrDown, participantShare } from '@/lib/money/calc'
import { payoutBySubmission } from '@/lib/clips/payouts'
import { JoinClipButton } from './JoinClipButton'
import { SubmitClipForm } from './SubmitClipForm'
import { ClipSubmissionRow } from './ClipSubmissionRow'

const PLATFORM_LABEL = { TIKTOK: 'TikTok', INSTAGRAM: 'Instagram' } as const

/**
 * Clip campaign detail — docs/14 §1. The page is the creator loop in order: what you
 * get, what the post must contain, join, submit, and the clips already in.
 *
 * Every figure comes from the row or the ledger: members are counted, the budget line is
 * `campaignBalance`, and the rate is the participant share of the CPM the brand set.
 */
export async function ClipCampaignDetail({
  campaign,
  user,
  accounts,
}: {
  campaign: Campaign & { payoutTemplate: PayoutTemplate | null; brand: { name: string } }
  user: Pick<User, 'id' | 'state'>
  accounts: Pick<SocialAccount, 'id' | 'platform' | 'tier'>[]
}) {
  const t = await getTranslations('clips.detail')
  const td = await getTranslations('campaigns.detail')
  const locale = await getLocale()
  const nf = new Intl.NumberFormat(locale === 'sv' ? 'sv-SE' : 'en-GB')
  const df = new Intl.DateTimeFormat(locale === 'sv' ? 'sv-SE' : 'en-GB', {
    dateStyle: 'medium',
    timeZone: 'Europe/Stockholm',
  })

  const [membership, members, balance, submissions] = await Promise.all([
    prisma.campaignMembership.findUnique({
      where: { campaignId_userId: { campaignId: campaign.id, userId: user.id } },
      select: { state: true },
    }),
    prisma.campaignMembership.count({ where: { campaignId: campaign.id, state: 'JOINED', deletedAt: null } }),
    campaignBalance(prisma, campaign.id),
    prisma.submission.findMany({
      where: { campaignId: campaign.id, userId: user.id, deletedAt: null },
      orderBy: { submittedAt: 'desc' },
    }),
  ])
  const payouts = await payoutBySubmission(submissions.map((s) => s.id))

  const joined = membership?.state === 'JOINED'
  const ended = campaign.endsAt !== null && campaign.endsAt <= new Date()
  const platforms = campaign.platforms.map((p) => PLATFORM_LABEL[p]).join(' / ')
  const connected = accounts.some((a) => a.tier === 'CONNECTED_API' && campaign.platforms.includes(a.platform))
  const days = Math.round(campaign.validationHours / 24)
  const template = campaign.payoutTemplate
  const disclosure = campaign.disclosureText.replace('{brand}', campaign.brand.name)
  const budgetGone = balance.availableOre <= 0

  return (
    <article>
      <p className="text-sm text-[var(--color-ink-2)]">{campaign.brand.name}</p>
      <h1 className="text-2xl mb-1">{campaign.name}</h1>
      <p className="text-xs text-[var(--color-ink-3)] mb-5 tabular">
        {t('members', { count: nf.format(members) })}
        {campaign.perPersonCap > 0 && <> · {t('capPerPerson', { count: campaign.perPersonCap })}</>}
      </p>

      {template && (
        <section className="card p-4 mb-4">
          <h2 className="label">{t('rate')}</h2>
          <p className="amount text-xl font-bold">
            {t('perThousand', { amount: formatKrDown(participantShare(template.cpmOre), locale) })}
          </p>
          <ul className="text-sm text-[var(--color-ink-2)] mt-1 grid gap-0.5">
            {template.viewFloor > 0 && <li>{t('viewFloor', { views: nf.format(template.viewFloor) })}</li>}
            <li>{t('maxPerClip', { amount: formatKrDown(participantShare(campaign.perPlacementMax), locale) })}</li>
            <li>{t('tracking', { days })}</li>
          </ul>
          <p className={`text-sm mt-2 tabular ${budgetGone ? 'text-[var(--color-red)]' : 'text-[var(--color-ink-2)]'}`}>
            {budgetGone ? t('budgetGone') : t('budgetLeft', { amount: formatKrDown(balance.availableOre, locale) })}
          </p>
        </section>
      )}

      <section className="mb-4">
        <h2 className="label">{t('how')}</h2>
        <ol className="text-sm text-[var(--color-ink-2)] grid gap-1 list-decimal pl-5">
          <li>{t('step1')}</li>
          <li>{t('step2', { platforms })}</li>
          <li>{t('step3', { days })}</li>
          <li>{t('step4')}</li>
        </ol>
      </section>

      <section className="card p-4 mb-4 grid gap-3 text-sm">
        <div>
          <h2 className="label">{t('platforms')}</h2>
          <p>{platforms}</p>
        </div>
        <div>
          <h2 className="label">{td('disclosure')}</h2>
          <p className="tabular font-semibold">{disclosure}</p>
        </div>
        {campaign.requiredHashtags.length > 0 && (
          <div>
            <h2 className="label">{t('hashtags')}</h2>
            <p className="tabular">{campaign.requiredHashtags.join(' ')}</p>
          </div>
        )}
        {campaign.requiredMentions.length > 0 && (
          <div>
            <h2 className="label">{t('mentions')}</h2>
            <p className="tabular">{campaign.requiredMentions.join(' ')}</p>
          </div>
        )}
        {campaign.rulesText && (
          <div>
            <h2 className="label">{td('rules')}</h2>
            <p className="text-[var(--color-ink-2)] whitespace-pre-line">{campaign.rulesText}</p>
          </div>
        )}
        {campaign.endsAt && (
          <div>
            <h2 className="label">{t('window')}</h2>
            <p>{t('windowUntil', { date: df.format(campaign.endsAt) })}</p>
          </div>
        )}
      </section>

      <section className="mb-4">
        {ended ? (
          <p className="card p-4 text-sm text-[var(--color-ink-2)]">{t('ended')}</p>
        ) : !connected && !joined ? (
          <div className="card p-4 grid gap-2">
            <p className="text-sm text-[var(--color-ink-2)]">{t('connectFirst', { platforms })}</p>
            <Link href="/accounts" className="btn btn-primary">
              {t('connect')}
            </Link>
          </div>
        ) : !joined && campaign.joinsPausedAt ? (
          <p className="card p-4 text-sm text-[var(--color-ink-2)]">{t('joinsPaused')}</p>
        ) : (
          <JoinClipButton campaignId={campaign.id} joined={joined} />
        )}
      </section>

      {joined && !ended && (
        <section className="mb-6">
          {campaign.submissionsPausedAt ? (
            <p className="card p-4 text-sm text-[var(--color-ink-2)]">{t('paused')}</p>
          ) : (
            <SubmitClipForm campaignId={campaign.id} />
          )}
        </section>
      )}

      <section>
        <h2 className="label">{t('yourClips')}</h2>
        {submissions.length === 0 ? (
          <p className="text-sm text-[var(--color-ink-3)]">{t('noClips')}</p>
        ) : (
          <ul className="grid gap-2">
            {submissions.map((row) => (
              <ClipSubmissionRow key={row.id} row={row} payoutOre={payouts.get(row.id)} />
            ))}
          </ul>
        )}
      </section>
    </article>
  )
}
