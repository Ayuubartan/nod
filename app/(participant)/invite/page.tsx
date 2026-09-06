import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireParticipant } from '@/lib/auth'
import { formatKrDown } from '@/lib/money/calc'
import { DEFAULTS } from '@/lib/money/rates'
import { CopyLink } from '@/components/CopyLink'

/** Referrals — docs/02 A8. */
export const dynamic = 'force-dynamic'

export default async function InvitePage() {
  const user = await requireParticipant()
  const t = await getTranslations('invite')

  const [invited, verified, withPlacement] = await Promise.all([
    prisma.referral.count({ where: { referrerId: user.id } }),
    prisma.user.count({
      where: { referredById: user.id, state: { in: ['VERIFIED', 'ACTIVE'] } },
    }),
    prisma.referral.count({ where: { referrerId: user.id, firstPlacementAt: { not: null } } }),
  ])

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const link = `${siteUrl}/?ref=${user.referralCode}`

  const stats = [
    { label: t('invited'), value: invited },
    { label: t('verified'), value: verified },
    { label: t('firstPlacement'), value: withPlacement },
  ]

  return (
    <div>
      <h1 className="text-2xl mb-1">{t('title')}</h1>
      <p className="text-sm text-[var(--color-ink-2)] mb-6">
        {t('sub', { amount: formatKrDown(DEFAULTS.referralBonusOre) })}
      </p>

      <section className="card p-4 mb-6">
        <h2 className="label">{t('yourLink')}</h2>
        <CopyLink value={link} />
      </section>

      <ul className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <li key={stat.label} className="card p-3 text-center">
            <p className="amount text-2xl font-bold">{stat.value}</p>
            <p className="text-xs text-[var(--color-ink-2)]">{stat.label}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
