import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireParticipant } from '@/lib/auth'
import { ConnectAccountButton } from '@/components/participant/ConnectAccountButton'

/** Connected accounts — docs/02 A6. */
export const dynamic = 'force-dynamic'

export default async function AccountsPage() {
  const user = await requireParticipant()
  const t = await getTranslations('accounts')

  const accounts = await prisma.socialAccount.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  })

  return (
    <div>
      <h1 className="text-2xl mb-4">{t('title')}</h1>

      <ul className="grid gap-2 mb-6">
        {accounts.map((account) => (
          <li key={account.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold">@{account.handle}</p>
                <p className="text-xs text-[var(--color-ink-3)]">
                  {account.platform} · {account.followers.toLocaleString('sv-SE')} · {account.avgViews30d.toLocaleString('sv-SE')}
                </p>
              </div>
              <span className="chip text-xs">{t(`tier.${account.tier}`)}</span>
            </div>

            {account.tier === 'BELOW_FLOOR' && (
              <p className="text-xs text-[var(--color-ink-3)] mt-2">{t('belowFloorHint')}</p>
            )}
            {account.tier === 'DISCONNECTED' && (
              <>
                <p className="text-xs text-[var(--color-red)] mt-2">{t('disconnectedHint')}</p>
                <ConnectAccountButton label={t('reconnect')} className="btn btn-secondary w-full mt-3 text-sm" />
              </>
            )}
          </li>
        ))}
      </ul>

      <ConnectAccountButton label={t('add')} className="btn btn-primary w-full" />
    </div>
  )
}
