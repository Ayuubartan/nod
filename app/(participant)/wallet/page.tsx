import Link from 'next/link'
import { BRAND } from '@/lib/brand'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireParticipant } from '@/lib/auth'
import { walletBalance, walletPendingOre } from '@/lib/money/balances'
import { formatKrDown, formatOre } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import { tryDecrypt } from '@/lib/crypto'
import { SwishForm } from '@/components/participant/SwishForm'

/** Wallet — docs/02 A5: pending / available / paid out, plus the transaction list. */
export const dynamic = 'force-dynamic'

export default async function WalletPage() {
  const user = await requireParticipant()
  const t = await getTranslations('wallet')

  const wallet = await prisma.wallet.upsert({
    where: { userId: user.id },
    create: { userId: user.id },
    update: {},
    select: { id: true },
  })

  const [balance, pendingOre, entries, cards] = await Promise.all([
    walletBalance(prisma, wallet.id),
    walletPendingOre(prisma, user.id),
    prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.placement.findMany({
      where: { userId: user.id, state: { in: ['QUALIFIED', 'PAID'] } },
      select: { id: true, campaign: { select: { brand: { select: { name: true } } } } },
      orderBy: { paidAt: 'desc' },
      take: 12,
    }),
  ])

  // Onboarding does not ask for Swish; the first place it matters is here.
  const swish = tryDecrypt(user.swishNumber)
  const maskedSwish = swish ? `${swish.slice(0, 6)}•••${swish.slice(-2)}` : null
  const needsSwish = !swish
  const hasMoney = balance.availableOre > 0 || pendingOre > 0

  const stats = [
    { label: t('pending'), value: pendingOre, tone: 'var(--color-ink-2)' },
    { label: t('available'), value: balance.availableOre, tone: 'var(--color-orange-dk)' },
    { label: t('paidOut'), value: balance.paidOutOre, tone: 'var(--color-green)' },
  ]

  return (
    <div>
      <h1 className="text-2xl mb-4">{t('title')}</h1>

      <ul className="grid grid-cols-3 gap-2 mb-3">
        {stats.map((stat) => (
          <li key={stat.label} className="card p-3">
            <p className="text-xs text-[var(--color-ink-2)] mb-1">{stat.label}</p>
            <p className="amount font-bold" style={{ color: stat.tone }}>
              {formatKrDown(stat.value)}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-xs text-[var(--color-ink-3)] mb-6">
        {t('threshold', { amount: formatKrDown(DEFAULTS.payoutThresholdOre) })}
      </p>

      {needsSwish && (
        <section className={`card p-4 mb-6 ${hasMoney ? 'border-[var(--color-orange)]' : ''}`}>
          <h2 className="label">{t('addSwish')}</h2>
          <p className="text-sm text-[var(--color-ink-2)] mb-3">{t(hasMoney ? 'addSwishNow' : 'addSwishHint')}</p>
          <SwishForm maskedSwish={maskedSwish} primary={hasMoney} />
        </section>
      )}

      {cards.length > 0 && (
        <section className="mb-6">
          <h2 className="label">{t('cards')}</h2>
          <ul className="flex gap-2 overflow-x-auto pb-2">
            {cards.map((card) => (
              <li key={card.id}>
                <a
                  href={`/api/og/earnings/${card.id}`}
                  download
                  className="chip whitespace-nowrap"
                >
                  {card.campaign.brand.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="label">{t('transactions')}</h2>
        {entries.length === 0 ? (
          <p className="card p-6 text-center text-sm text-[var(--color-ink-2)]">{t('empty')}</p>
        ) : (
          <ul className="grid gap-1">
            {entries.map((entry) => (
              <li key={entry.id} className="card px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm truncate">{entry.memo ?? entry.type}</p>
                  <p className="text-xs text-[var(--color-ink-3)] tabular">
                    {entry.createdAt.toLocaleDateString('sv-SE')}
                  </p>
                </div>
                <span
                  className="amount font-semibold whitespace-nowrap"
                  style={{ color: entry.type === 'PAYOUT_SENT' ? 'var(--color-ink-2)' : 'var(--color-green)' }}
                >
                  {entry.type === 'PAYOUT_SENT' ? '−' : '+'}
                  {formatOre(entry.amountOre)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-6 text-center">
        <Link href="/invite" className="text-sm underline text-[var(--color-ink-2)]">
          {BRAND}
        </Link>
      </p>
    </div>
  )
}
