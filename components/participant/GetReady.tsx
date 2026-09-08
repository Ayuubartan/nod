import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Countdown } from '@/components/Countdown'
import { EnableNotifications } from './EnableNotifications'

export type ReadyChecks = {
  connected: boolean
  verified: boolean
  notifications: boolean
}

/**
 * What a creator sees after joining, before there is anything to claim: when the next
 * drop is, and the three things that decide whether they can take a campaign the
 * moment it opens. Each row links to where it gets done; done rows stay as receipts.
 *
 * This replaces an empty list and a "verify to unlock" wall — the wall read as a
 * gate on browsing, when it only gates claiming (docs/02 A1: BankID at first claim).
 */
export async function GetReady({
  nextDrop,
  checks,
  estimate,
  referralBonus,
}: {
  nextDrop: Date
  checks: ReadyChecks
  /** "~140 kr", or null when no account is connected yet. */
  estimate: string | null
  referralBonus: string
}) {
  const t = await getTranslations('campaigns.ready')

  const rows: Array<{ key: 'connected' | 'verified'; href: string; done: boolean }> = [
    { key: 'connected', href: '/accounts', done: checks.connected },
    { key: 'verified', href: '/verify', done: checks.verified },
  ]
  const labels = {
    connected: { todo: t('connect'), done: t('connectDone'), hint: t('connectHint') },
    verified: { todo: t('verify'), done: t('verifyDone'), hint: t('verifyHint') },
  }
  const allDone = rows.every((row) => row.done)
  const rowClass = 'flex w-full items-start gap-3 rounded-xl border px-4 py-3'

  return (
    <section className="card p-5 mb-5" aria-labelledby="get-ready">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 id="get-ready" className="text-lg">
          {t('title')}
        </h2>
        <Countdown
          to={nextDrop.toISOString()}
          className="text-sm font-semibold text-[var(--color-amber-dk)]"
        />
      </div>
      <p className="text-sm text-[var(--color-ink-2)] mb-4">
        {nextDrop.toLocaleString('sv-SE', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}{' '}
        · {allDone ? t('allSet') : t('sub')}
      </p>
      {estimate && (
        <p className="text-sm font-semibold mb-4">{t('estimate', { amount: estimate })}</p>
      )}

      <ol className="grid gap-2">
        {rows.map((row) => (
          <li key={row.key}>
            <Link
              href={row.href}
              className={`${rowClass} ${
                row.done
                  ? 'border-[var(--color-line)] text-[var(--color-ink-2)]'
                  : 'border-[var(--color-amber)]'
              }`}
              aria-current={row.done ? undefined : 'step'}
            >
              <span
                className={`mt-0.5 h-5 w-5 shrink-0 rounded-full border text-xs flex items-center justify-center ${
                  row.done
                    ? 'bg-[var(--color-ink)] border-[var(--color-ink)] text-white'
                    : 'border-[var(--color-amber)]'
                }`}
                aria-hidden="true"
              >
                {row.done ? '✓' : ''}
              </span>
              <span>
                <span className="block text-sm font-semibold">
                  {row.done ? labels[row.key].done : labels[row.key].todo}
                </span>
                {!row.done && (
                  <span className="block text-xs text-[var(--color-ink-2)]">
                    {labels[row.key].hint}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
        {checks.notifications ? (
          <li className={`${rowClass} border-[var(--color-line)] text-[var(--color-ink-2)]`}>
            <span
              className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-[var(--color-ink)] text-white text-xs flex items-center justify-center"
              aria-hidden="true"
            >
              ✓
            </span>
            <span className="block text-sm font-semibold">{t('notifyDone')}</span>
          </li>
        ) : (
          <li>
            <EnableNotifications
              label={t('notify')}
              hint={t('notifyHint')}
              className={`${rowClass} border-[var(--color-amber)]`}
            />
          </li>
        )}
        <li>
          <Link href="/invite" className={`${rowClass} border-[var(--color-line)]`}>
            <span
              className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-[var(--color-line)]"
              aria-hidden="true"
            />
            <span>
              <span className="block text-sm font-semibold">{t('invite')}</span>
              <span className="block text-xs text-[var(--color-ink-2)]">
                {t('inviteHint', { amount: referralBonus })}
              </span>
            </span>
          </Link>
        </li>
      </ol>
    </section>
  )
}
