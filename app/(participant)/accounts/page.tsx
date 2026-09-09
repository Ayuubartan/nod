import { getLocale, getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireParticipant } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { PLATFORMS, usesFake } from '@/lib/integrations/social'
import { accountAnalytics, MANUAL_SYNC_COOLDOWN_MS } from '@/lib/social-sync'
import { ConnectAccountButton } from '@/components/participant/ConnectAccountButton'
import { AccountActions } from '@/components/participant/AccountActions'
import { Sparkline } from '@/components/participant/Sparkline'

/** Connected accounts and their analytics — docs/02 A6, docs/06 sections 1-2. */
export const dynamic = 'force-dynamic'

const ERROR_KEYS = [
  'denied',
  'state',
  'invalidPlatform',
  'connectFailed',
  'accountTaken',
  'tooSoon',
  'syncFailed',
  'disconnected',
  'notFound',
] as const

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>
}) {
  const user = await requireParticipant()
  const [t, locale, params] = await Promise.all([getTranslations('accounts'), getLocale(), searchParams])

  const [accounts, analytics] = await Promise.all([
    prisma.socialAccount.findMany({ where: { userId: user.id, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    accountAnalytics(user.id),
  ])
  const byId = new Map(analytics.map((a) => [a.accountId, a]))

  const number = new Intl.NumberFormat(locale)
  const signed = new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' })
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })

  const errorKey = ERROR_KEYS.find((k) => k === params.error)
  const errorMessages = Object.fromEntries(ERROR_KEYS.map((k) => [k, t(`error.${k}`)]))
  const actionLabels = {
    sync: t('sync'),
    syncing: t('syncing'),
    disconnect: t('disconnect'),
    disconnecting: t('disconnecting'),
  }

  return (
    <div>
      <h1 className="text-2xl mb-1">{t('title')}</h1>
      <p className="text-sm text-[var(--color-ink-2)] mb-4">{t.rich('sub', { brand: () => BRAND })}</p>

      {params.connected && (
        <p className="card px-3 py-2 text-sm mb-4 border-[var(--color-teal)]">{t('connected')}</p>
      )}
      {errorKey && <p className="card px-3 py-2 text-sm mb-4 text-[var(--color-red)]">{t(`error.${errorKey}`)}</p>}

      <ul className="grid gap-3 mb-6">
        {accounts.map((account) => {
          const a = byId.get(account.id)
          const live = account.tier !== 'DISCONNECTED'
          const canSync =
            live &&
            account.accessToken != null &&
            (account.lastSyncedAt == null || Date.now() - account.lastSyncedAt.getTime() >= MANUAL_SYNC_COOLDOWN_MS)

          return (
            <li key={account.id} className="card p-4 grid gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-[var(--color-ink-3)]">
                    {t(`platform.${account.platform}`)}
                  </p>
                  <p className="font-semibold">@{account.handle}</p>
                </div>
                <span className="chip text-xs" aria-pressed={account.tier === 'CONNECTED_API'}>
                  {t(`tier.${account.tier}`)}
                </span>
              </div>

              <dl className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-[var(--color-ink-3)]">{t('stats.followers')}</dt>
                  <dd className="amount text-lg">{number.format(account.followers)}</dd>
                  {a?.followersDelta30d != null && (
                    <dd className={`text-xs ${a.followersDelta30d >= 0 ? 'text-[var(--color-green)]' : 'text-[var(--color-red)]'}`}>
                      {signed.format(a.followersDelta30d)}
                    </dd>
                  )}
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-ink-3)]">{t('stats.avgViews')}</dt>
                  <dd className="amount text-lg">{number.format(account.avgViews30d)}</dd>
                  {a?.avgViewsDelta30d != null && (
                    <dd className={`text-xs ${a.avgViewsDelta30d >= 0 ? 'text-[var(--color-green)]' : 'text-[var(--color-red)]'}`}>
                      {signed.format(a.avgViewsDelta30d)}
                    </dd>
                  )}
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-ink-3)]">{t('stats.posts30d')}</dt>
                  <dd className="amount text-lg">{a?.posts30d != null ? number.format(a.posts30d) : '—'}</dd>
                </div>
              </dl>

              {a && a.history.length >= 2 ? (
                <div>
                  <p className="text-xs text-[var(--color-ink-3)] mb-1">{t('stats.change30d')}</p>
                  <Sparkline values={a.history.map((h) => h.followers)} />
                </div>
              ) : (
                live && <p className="text-xs text-[var(--color-ink-3)]">{t('stats.noHistory')}</p>
              )}

              <p className="text-xs text-[var(--color-ink-3)]">
                {account.lastSyncedAt ? t('lastSynced', { when: when.format(account.lastSyncedAt) }) : t('neverSynced')}
              </p>

              {account.tier === 'BELOW_FLOOR' && <p className="text-xs text-[var(--color-ink-3)]">{t('belowFloorHint')}</p>}
              {account.isPrivate && live && <p className="text-xs text-[var(--color-ink-3)]">{t('privateHint')}</p>}

              {account.tier === 'DISCONNECTED' ? (
                <>
                  <p className="text-xs text-[var(--color-red)]">{t('disconnectedHint')}</p>
                  <ConnectAccountButton
                    platform={account.platform}
                    oauth={!usesFake(account.platform)}
                    label={t('reconnect')}
                    placeholder={t('handlePlaceholder')}
                    className="btn btn-secondary w-full text-sm"
                  />
                </>
              ) : (
                <AccountActions accountId={account.id} canSync={canSync} labels={actionLabels} errors={errorMessages} />
              )}
            </li>
          )
        })}
      </ul>

      <div className="grid gap-2">
        {PLATFORMS.map((platform) => (
          <ConnectAccountButton
            key={platform}
            platform={platform}
            oauth={!usesFake(platform)}
            label={platform === 'TIKTOK' ? t('connectTiktok') : t('connectInstagram')}
            placeholder={t('handlePlaceholder')}
            className={platform === 'TIKTOK' ? 'btn btn-secondary w-full' : 'btn btn-primary w-full'}
          />
        ))}
        <p className="text-xs text-[var(--color-ink-3)] text-center">{t('readOnly')}</p>
      </div>
    </div>
  )
}
