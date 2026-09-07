import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { prisma } from '@/lib/db'
import { requireParticipant } from '@/lib/auth'
import { StateChip } from '@/components/StateChip'
import { Countdown } from '@/components/Countdown'
import { UploadStep } from '@/components/participant/UploadStep'
import { PositionStep } from '@/components/participant/PositionStep'
import { ReviewStep } from '@/components/participant/ReviewStep'
import { GeneratingPoll } from '@/components/participant/GeneratingPoll'
import { PostStep } from '@/components/participant/PostStep'
import { formatKrDown } from '@/lib/money/calc'
import { LIMITS } from '@/lib/money/rates'

/**
 * The single screen a participant lives in between claiming and getting paid.
 * Which step renders is driven entirely by the placement's state (docs/02 A3), so the
 * UI can never disagree with the state machine.
 */
export const dynamic = 'force-dynamic'

export default async function PlacementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireParticipant()
  const t = await getTranslations('placement')

  const placement = await prisma.placement.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    include: {
      campaign: { include: { assets: true, brand: { select: { name: true } } } },
      account: { select: { handle: true, platform: true, tier: true } },
      versions: { orderBy: { createdAt: 'desc' }, take: 1 },
      verification: true,
    },
  })
  if (!placement) notFound()

  // What the participant was actually paid comes from the ledger, never from the
  // reservation — the two differ whenever the post under- or over-performed.
  const accrued = await prisma.ledgerEntry.aggregate({
    where: { placementId: placement.id, type: 'PAYOUT_ACCRUE' },
    _sum: { amountOre: true },
  })
  const earnedOre = accrued._sum.amountOre ?? 0

  const currentVersion = placement.versions[0] ?? null

  return (
    <article>
      <header className="mb-5">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div>
            <p className="text-sm text-[var(--color-ink-2)]">{placement.campaign.brand.name}</p>
            <h1 className="text-xl">{placement.campaign.name}</h1>
          </div>
          <StateChip state={placement.state} />
        </div>

        {!['PAID', 'REJECTED', 'EXPIRED', 'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND'].includes(
          placement.state,
        ) &&
          !placement.clockPausedAt && (
            <Countdown to={placement.deadlineAt.toISOString()} className="text-xs text-[var(--color-ink-3)]" />
          )}
      </header>

      {placement.state === 'CLAIMED' && <UploadStep placementId={placement.id} />}

      {placement.state === 'UPLOADED' && (
        <PositionStep
          placementId={placement.id}
          originalPath={placement.originalPath}
          assets={placement.campaign.assets
            .filter((a) => !a.deletedAt)
            .map((a) => ({ id: a.id, name: a.name, storagePath: a.storagePath }))}
        />
      )}

      {(placement.state === 'POSITIONED' || placement.state === 'GENERATING') && (
        <section className="card p-6 text-center">
          <h2 className="text-lg mb-1">{t('generating.title')}</h2>
          <p className="text-sm text-[var(--color-ink-2)]">
            {t('generating.sub', { time: '4h' })}
          </p>
          <GeneratingPoll />
        </section>
      )}

      {placement.state === 'GENERATION_FAILED' && (
        <section className="card p-6 text-center">
          <p className="text-sm text-[var(--color-red)]">{t('generating.failed')}</p>
        </section>
      )}

      {placement.state === 'PARTICIPANT_REVIEW' && (
        <ReviewStep
          placementId={placement.id}
          beforePath={placement.originalPath}
          afterPath={currentVersion?.storagePath ?? null}
          regensLeft={LIMITS.maxRegens - placement.regenCount}
          assets={placement.campaign.assets.filter((a) => !a.deletedAt).map((a) => ({ id: a.id, name: a.name }))}
        />
      )}

      {placement.state === 'BRAND_REVIEW' && (
        <section className="card p-6 text-center">
          <p className="text-sm text-[var(--color-ink-2)]">{t('review.brandReviewing')}</p>
        </section>
      )}

      {placement.state === 'APPROVED' && (
        <PostStep
          placementId={placement.id}
          disclosure={placement.disclosureTextIssued ?? ''}
          handle={placement.account.handle}
          mediaPath={currentVersion?.storagePath ?? null}
          autoDetect={placement.account.tier === 'CONNECTED_API'}
        />
      )}

      {placement.state === 'PUBLISHED' && (
        <section className="card p-6 text-center">
          <h2 className="text-lg mb-1">{t('published.title')}</h2>
          <p className="text-sm text-[var(--color-ink-2)] mb-1">
            {t('published.verifyingOn', {
              date: placement.holdEndsAt?.toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }) ?? '',
            })}
          </p>
          <p className="text-xs text-[var(--color-ink-3)]">{t('published.dontDelete')}</p>
        </section>
      )}

      {(placement.state === 'VERIFYING' || placement.state === 'FLAGGED') && (
        <section className="card p-6 text-center">
          <p className="text-sm text-[var(--color-ink-2)]">{t('states.VERIFYING')}</p>
        </section>
      )}

      {(placement.state === 'QUALIFIED' || placement.state === 'PAID') && (
        <section className="card p-6 text-center">
          <h2 className="text-lg mb-2">{t('result.qualifiedTitle')}</h2>
          <p className="amount text-3xl font-extrabold text-[var(--color-green)] mb-1">
            {t('result.earned', { amount: formatKrDown(earnedOre) })}
          </p>
          {placement.verification?.qualifiedViews != null && (
            <p className="text-sm text-[var(--color-ink-2)]">
              {t('result.views', { views: placement.verification.qualifiedViews.toLocaleString('sv-SE') })}
            </p>
          )}
          <a href={`/api/og/earnings/${placement.id}`} download className="btn btn-primary mt-4">
            {t('result.shareCard')}
          </a>
        </section>
      )}

      {['REJECTED', 'REJECTED_BY_BRAND', 'REJECTED_BY_PARTICIPANT', 'EXPIRED'].includes(placement.state) && (
        <section className="card p-6">
          <h2 className="text-lg mb-2">{t('result.rejectedTitle')}</h2>
          {placement.rejectReason && (
            <p className="text-sm text-[var(--color-ink-2)] mb-2">
              {t(`rejectReasons.${placement.rejectReason}`)}
            </p>
          )}
          {placement.fixWindowEndsAt && placement.fixWindowEndsAt > new Date() && (
            <>
              <p className="text-sm mb-1">
                <Countdown to={placement.fixWindowEndsAt.toISOString()} />
              </p>
              <p className="text-sm text-[var(--color-ink-2)]">{t('result.fixDisclosure')}</p>
            </>
          )}
        </section>
      )}
    </article>
  )
}
