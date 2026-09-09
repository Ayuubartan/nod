import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { requireParticipant } from '@/lib/auth'
import { marketplaceFor, nextDropLabel, type MarketplaceTab } from '@/lib/marketplace'
import { estimateParticipantOre, formatKrDown } from '@/lib/money/calc'
import { DEFAULTS, ESTIMATOR_RANGE } from '@/lib/money/rates'
import { prisma } from '@/lib/db'
import { Countdown } from '@/components/Countdown'
import { GetReady } from '@/components/participant/GetReady'

/**
 * Marketplace — docs/02 section A2.
 * Every card shows what THIS participant would earn on THEIR best eligible account.
 *
 * It is also the home screen after joining. Until the creator is ready to claim (an
 * account connected, BankID done) or while there is nothing to claim, the top of the
 * page is the countdown to the next drop and the steps to be ready for it.
 */
export const dynamic = 'force-dynamic'

const TABS: MarketplaceTab[] = ['forYou', 'highestPaying', 'new', 'endingSoon']

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const user = await requireParticipant()
  const t = await getTranslations('campaigns')
  const { tab } = await searchParams

  const activeTab = (TABS as string[]).includes(tab ?? '') ? (tab as MarketplaceTab) : 'forYou'
  const cards = await marketplaceFor(user.id, activeTab)

  const account = await prisma.socialAccount.findFirst({
    where: { userId: user.id, deletedAt: null },
    orderBy: { avgViews30d: 'desc' },
    select: { avgViews30d: true },
  })
  const checks = {
    connected: account !== null,
    verified: user.state !== 'SIGNED_UP' && user.state !== 'ONBOARDED',
    notifications: user.pushSubscription !== null,
  }
  const ready = checks.connected && checks.verified
  const showGetReady = !ready || cards.length === 0

  return (
    <div>
      <h1 className="text-2xl mb-4">{t('title')}</h1>

      {showGetReady && (
        <GetReady
          nextDrop={nextDropLabel()}
          checks={checks}
          estimate={
            account
              ? formatKrDown(
                  estimateParticipantOre(ESTIMATOR_RANGE.high, account.avgViews30d || 450),
                )
              : null
          }
          referralBonus={formatKrDown(DEFAULTS.referralBonusOre)}
        />
      )}

      <nav
        className="flex gap-2 overflow-x-auto pb-2 mb-4 -mx-5 px-5"
        aria-label="Campaign filters"
      >
        {TABS.map((name) => (
          <Link
            key={name}
            href={`/campaigns?tab=${name}`}
            className="chip whitespace-nowrap"
            aria-pressed={activeTab === name}
          >
            {t(`tabs.${name}`)}
          </Link>
        ))}
      </nav>

      {cards.length === 0 ? (
        showGetReady ? null : (
          <div className="card p-6 text-center">
            <h2 className="text-lg mb-1">{t('empty.title')}</h2>
            <p className="text-sm text-[var(--color-ink-2)]">
              {t('empty.sub', {
                date: nextDropLabel().toLocaleString('sv-SE', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </p>
          </div>
        )
      ) : (
        <ul className="grid gap-3">
          {cards.map(({ campaign, eligibility, remainingPercent, endsAt }) => (
            <li key={campaign.id}>
              <Link href={`/campaigns/${campaign.id}`} className="card p-4 block">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <h2 className="font-semibold">
                      {campaign.brand.name}
                      {campaign.kind === 'CLIP' && (
                        <span className="ml-2 align-middle inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold bg-[var(--color-line)] text-[var(--color-ink-2)]">
                          {t('clipChip')}
                        </span>
                      )}
                    </h2>
                    <p className="text-sm text-[var(--color-ink-2)]">{campaign.name}</p>
                  </div>
                  {eligibility.eligible ? (
                    <span className="amount font-bold text-[var(--color-orange-dk)] whitespace-nowrap">
                      {t('youGet', { amount: formatKrDown(eligibility.estimateOre) })}
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--color-ink-3)] whitespace-nowrap">
                      {t('notEligible')}
                    </span>
                  )}
                </div>

                {!eligibility.eligible && (
                  <p className="text-xs text-[var(--color-ink-3)] mb-2">
                    {t(`reasons.${eligibility.reason}`, {
                      min: eligibility.detail ?? '',
                      cities: eligibility.detail ?? '',
                    })}
                  </p>
                )}

                <div className="flex items-center gap-3 text-xs text-[var(--color-ink-2)]">
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--color-line)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--color-orange)]"
                      style={{ width: `${remainingPercent}%` }}
                      role="progressbar"
                      aria-valuenow={remainingPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={t('remaining', { percent: remainingPercent })}
                    />
                  </div>
                  <span className="tabular">{t('remaining', { percent: remainingPercent })}</span>
                  {endsAt && <Countdown to={endsAt.toISOString()} />}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
