import { notFound } from 'next/navigation'
import Link from 'next/link'
import { prisma } from '@/lib/db'
import { devAuthAllowed } from '@/lib/auth'
import { PersonaSwitcher } from '@/components/DevPersonaSwitcher'

/**
 * Development-only persona switcher.
 *
 * The real sign-in is an emailed six-digit code (/sign-in, /brand/sign-in), which is a
 * few clicks per persona. This page sets a dev cookie instead so the three surfaces can
 * be walked with one click each.
 *
 * It 404s in production, and the cookie it sets is ignored there too (lib/auth.ts), so
 * there are two independent guards rather than one.
 */
export const dynamic = 'force-dynamic'

export default async function DevPage() {
  if (!devAuthAllowed()) notFound()

  const [participants, brandUsers, ops, campaigns] = await Promise.all([
    prisma.user.findMany({
      where: { role: 'PARTICIPANT' },
      select: {
        authId: true,
        state: true,
        city: true,
        accounts: { select: { handle: true, tier: true, followers: true, avgViews30d: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    prisma.brandUser.findMany({
      select: { authId: true, email: true, role: true, brand: { select: { name: true } } },
      take: 10,
    }),
    prisma.user.findMany({ where: { role: 'OPS' }, select: { authId: true, email: true }, take: 5 }),
    prisma.campaign.findMany({
      select: { id: true, name: true, state: true, brand: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 10,
    }),
  ])

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <div className="wrap max-w-4xl py-10">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-red)] mb-2">
          Development only
        </p>
        <h1 className="text-3xl mb-2">Sign in as…</h1>
        <p className="text-sm text-[var(--color-ink-2)] mb-8">
          Sets a dev cookie that stands in for a Supabase session. This page does not exist in
          production, and the cookie is ignored there.
        </p>

        <section className="mb-8">
          <h2 className="label">Participants</h2>
          <ul className="grid gap-2">
            {participants.map((user) => (
              <li key={user.authId} className="card p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-sm">
                    {user.accounts.map((a) => `@${a.handle}`).join(', ') || user.authId}
                  </p>
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {user.state} · {user.city ?? '—'} ·{' '}
                    {user.accounts
                      .map((a) => `${a.tier} ${a.followers.toLocaleString('sv-SE')}f / ${a.avgViews30d.toLocaleString('sv-SE')}v`)
                      .join(' · ')}
                  </p>
                </div>
                <PersonaSwitcher authId={user.authId} href="/campaigns" label="Open app" />
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="label">Brand users</h2>
          <ul className="grid gap-2">
            {brandUsers.map((user) => (
              <li key={user.authId} className="card p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-sm">{user.brand.name}</p>
                  <p className="text-xs text-[var(--color-ink-3)]">
                    {user.email} · {user.role}
                  </p>
                </div>
                <PersonaSwitcher authId={user.authId} href="/brand/campaigns" label="Open dashboard" />
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="label">Ops</h2>
          <ul className="grid gap-2">
            {ops.map((user) => (
              <li key={user.authId} className="card p-4 flex flex-wrap items-center justify-between gap-3">
                <p className="font-semibold text-sm">{user.email ?? user.authId}</p>
                <PersonaSwitcher authId={user.authId} href="/ops" label="Open console" />
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="label">Seeded campaigns</h2>
          <ul className="card divide-y divide-[var(--color-line)]">
            {campaigns.map((campaign) => (
              <li key={campaign.id} className="px-4 py-3 flex items-center justify-between gap-3 text-sm">
                <span>
                  {campaign.brand.name} · {campaign.name}
                </span>
                <span className="chip text-xs">{campaign.state}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="label">Public pages</h2>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { href: '/', label: 'Landing' },
                { href: '/brands', label: 'For brands' },
                { href: '/privacy', label: 'Privacy' },
                { href: '/terms', label: 'Terms' },
              ] as const
            ).map((page) => (
              <Link key={page.href} href={page.href} className="chip">
                {page.label}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
