import { getLocale, getTranslations } from 'next-intl/server'
import type { Submission } from '@prisma/client'
import { formatKrDown } from '@/lib/money/calc'
import { SubmissionStateChip } from './SubmissionStateChip'
import { RecheckClipButton } from './RecheckClipButton'

type Row = Pick<
  Submission,
  | 'id'
  | 'state'
  | 'platform'
  | 'canonicalUrl'
  | 'latestViews'
  | 'eligibleViews'
  | 'reservationOre'
  | 'budgetExhausted'
  | 'rejectReason'
  | 'fixWindowEndsAt'
  | 'validationEndsAt'
  | 'submittedAt'
> & { campaign?: { name: string; brand: { name: string } } }

/**
 * One clip as the creator sees it — docs/14 §1. Every number is the row's own: views
 * from the last provider pull, the reservation the ledger actually holds, and the payout
 * only once it is settled.
 */
export async function ClipSubmissionRow({ row, payoutOre }: { row: Row; payoutOre?: number }) {
  const t = await getTranslations('clips.row')
  const tr = await getTranslations('submission.rejectReasons')
  const locale = await getLocale()
  const nf = new Intl.NumberFormat(locale === 'sv' ? 'sv-SE' : 'en-GB')
  const dtf = new Intl.DateTimeFormat(locale === 'sv' ? 'sv-SE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Stockholm' })

  const settled = row.state === 'QUALIFIED' || row.state === 'PAID'

  return (
    <li className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {row.campaign && (
            <>
              <p className="font-semibold truncate">{row.campaign.brand.name}</p>
              <p className="text-sm text-[var(--color-ink-2)] truncate">{row.campaign.name}</p>
            </>
          )}
          <p className="text-xs text-[var(--color-ink-3)] tabular">
            {row.platform === 'TIKTOK' ? 'TikTok' : 'Instagram'} · {dtf.format(row.submittedAt)}
          </p>
        </div>
        <SubmissionStateChip state={row.state} />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm tabular">
        {row.latestViews !== null && <span>{t('views', { views: nf.format(row.latestViews) })}</span>}
        {row.eligibleViews > 0 && row.eligibleViews !== row.latestViews && (
          <span className="text-[var(--color-ink-2)]">{t('eligible', { views: nf.format(row.eligibleViews) })}</span>
        )}
        {settled && payoutOre !== undefined ? (
          <span className="font-semibold text-[var(--color-green)]">
            {row.state === 'PAID' ? t('paidOut', { amount: formatKrDown(payoutOre, locale) }) : t('earned', { amount: formatKrDown(payoutOre, locale) })}
          </span>
        ) : row.budgetExhausted ? (
          <span className="text-[var(--color-ink-3)]">{t('notPayable')}</span>
        ) : row.reservationOre > 0 ? (
          <span className="text-[var(--color-ink-2)]">{t('reserved', { amount: formatKrDown(row.reservationOre, locale) })}</span>
        ) : null}
      </div>

      {row.state === 'FIX_DISCLOSURE' && row.fixWindowEndsAt && (
        <div className="mt-2">
          <p className="text-sm text-[var(--color-orange-dk)]">{t('fixBy', { time: dtf.format(row.fixWindowEndsAt) })}</p>
          <RecheckClipButton submissionId={row.id} />
        </div>
      )}

      {(row.state === 'TRACKING' || row.state === 'VALIDATING') && row.validationEndsAt && (
        <p className="text-xs text-[var(--color-ink-3)] mt-1">{t('validationEnds', { date: dtf.format(row.validationEndsAt) })}</p>
      )}

      {row.state === 'REJECTED' && row.rejectReason && (
        <p className="text-xs text-[var(--color-red)] mt-1">{tr(row.rejectReason)}</p>
      )}

      <a
        href={row.canonicalUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-block text-xs underline text-[var(--color-ink-3)] mt-2"
      >
        {t('open')} ↗
      </a>
    </li>
  )
}
