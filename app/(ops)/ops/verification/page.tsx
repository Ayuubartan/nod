import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { mediaUrl } from '@/lib/media-url'
import { VerificationCard } from '@/components/ops/VerificationCard'
import { FraudCard } from '@/components/ops/FraudCard'
import { DisputeCard } from '@/components/ops/DisputeCard'

/**
 * Verification queue — docs/02 section C.
 *
 * Three sections, in the order ops should work them:
 *   1. screenshot-tier placements waiting for a view count
 *   2. fraud flags, with the score breakdown (48h SLA)
 *   3. open brand disputes
 */
export const dynamic = 'force-dynamic'

export default async function OpsVerificationPage() {
  await requireOps()

  const [awaitingViews, flagged, disputes] = await Promise.all([
    prisma.placement.findMany({
      where: { state: 'VERIFYING', deletedAt: null },
      include: {
        account: { select: { handle: true, tier: true, avgViews30d: true } },
        campaign: { select: { name: true, disclosureText: true, brand: { select: { name: true } } } },
        verification: true,
      },
      orderBy: { holdEndsAt: 'asc' },
      take: 50,
    }),
    prisma.placement.findMany({
      where: { state: 'FLAGGED', deletedAt: null },
      include: {
        account: { select: { handle: true, avgViews30d: true, followers: true } },
        campaign: { select: { name: true, brand: { select: { name: true } } } },
        verification: true,
        user: { select: { id: true, state: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    }),
    prisma.dispute.findMany({
      where: { state: 'OPEN' },
      include: {
        placement: {
          include: {
            account: { select: { handle: true } },
            verification: { select: { disclosureOk: true, mediaMatch: true, qualifiedViews: true } },
            campaign: { select: { name: true, brand: { select: { name: true } } } },
          },
        },
      },
      take: 50,
    }),
  ])

  return (
    <div className="grid gap-10">
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h1 className="text-xl">Awaiting view entry</h1>
          <p className="text-sm text-[var(--color-ink-2)] tabular">{awaitingViews.length}</p>
        </div>

        {awaitingViews.length === 0 ? (
          <p className="card p-6 text-center text-sm text-[var(--color-ink-3)]">Nothing waiting.</p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {awaitingViews.map((placement) => (
              <li key={placement.id}>
                <VerificationCard
                  placementId={placement.id}
                  handle={placement.account.handle}
                  tier={placement.account.tier}
                  campaignLabel={`${placement.campaign.brand.name} · ${placement.campaign.name}`}
                  postUrl={placement.postUrl}
                  expectedDisclosure={placement.disclosureTextIssued ?? placement.campaign.disclosureText}
                  avgViews30d={placement.account.avgViews30d}
                  screenshotUrl={
                    placement.verification?.screenshotPath
                      ? mediaUrl(placement.verification.screenshotPath)
                      : null
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-xl">Fraud queue</h2>
          <p className="text-sm text-[var(--color-ink-2)] tabular">{flagged.length} · 48h SLA</p>
        </div>

        {flagged.length === 0 ? (
          <p className="card p-6 text-center text-sm text-[var(--color-ink-3)]">No flags.</p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {flagged.map((placement) => (
              <li key={placement.id}>
                <FraudCard
                  placementId={placement.id}
                  handle={placement.account.handle}
                  campaignLabel={`${placement.campaign.brand.name} · ${placement.campaign.name}`}
                  score={placement.verification?.fraudScore ?? 0}
                  factors={
                    (placement.verification?.fraudFactors as Array<{
                      name: string
                      score: number
                      weight: number
                      detail: string
                    }> | null) ?? []
                  }
                  views={placement.verification?.views ?? 0}
                  avgViews30d={placement.account.avgViews30d}
                  followers={placement.account.followers}
                  flaggedSince={placement.updatedAt.toISOString()}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-xl">Disputes</h2>
          <p className="text-sm text-[var(--color-ink-2)] tabular">{disputes.length}</p>
        </div>

        {disputes.length === 0 ? (
          <p className="card p-6 text-center text-sm text-[var(--color-ink-3)]">No open disputes.</p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {disputes.map((dispute) => (
              <li key={dispute.id}>
                <DisputeCard
                  placementId={dispute.placementId}
                  handle={dispute.placement.account.handle}
                  campaignLabel={`${dispute.placement.campaign.brand.name} · ${dispute.placement.campaign.name}`}
                  reason={dispute.reason}
                  disclosureOk={dispute.placement.verification?.disclosureOk ?? null}
                  mediaMatch={dispute.placement.verification?.mediaMatch ?? null}
                  qualifiedViews={dispute.placement.verification?.qualifiedViews ?? null}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
