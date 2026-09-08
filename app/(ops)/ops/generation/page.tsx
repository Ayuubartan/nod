import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { mediaUrl } from '@/lib/media-url'
import { Countdown } from '@/components/Countdown'
import { GenerationCard } from '@/components/ops/GenerationCard'

/**
 * The generation queue — docs/02 section C, and the manual implementation of the
 * placement engine (docs/06 section 6).
 *
 * A human downloads the original, reads the chosen region and product, composites the
 * image in any tool, and uploads the result. That upload is what moves the placement
 * to PARTICIPANT_REVIEW. Until then the participant's clock is paused.
 */
export const dynamic = 'force-dynamic'

export default async function OpsGenerationPage() {
  await requireOps()

  const queue = await prisma.placement.findMany({
    where: { state: { in: ['GENERATING', 'GENERATION_FAILED'] }, deletedAt: null },
    include: {
      campaign: { select: { name: true, assets: true, brand: { select: { name: true } } } },
      account: { select: { handle: true } },
    },
    orderBy: { clockPausedAt: 'asc' },
    take: 100,
  })

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl">Generation queue</h1>
        <p className="text-sm text-[var(--color-ink-2)] tabular">{queue.length} waiting</p>
      </div>

      {queue.length === 0 ? (
        <p className="card p-8 text-center text-sm text-[var(--color-ink-3)]">Queue is empty.</p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {queue.map((placement) => {
            const region = placement.regionJson as { x: number; y: number; w: number; h: number; label?: string } | null
            const asset = placement.campaign.assets.find((a) => a.id === placement.assetId)

            return (
              <li key={placement.id} className="card p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="font-semibold text-sm">
                      {placement.campaign.brand.name} · {placement.campaign.name}
                    </p>
                    <p className="text-xs text-[var(--color-ink-3)]">
                      @{placement.account.handle} · {placement.contentType ?? '—'}
                      {placement.regenCount > 0 && ` · regen ${placement.regenCount}`}
                    </p>
                  </div>
                  <span className="chip text-xs">{placement.state}</span>
                </div>

                <dl className="grid grid-cols-2 gap-2 text-xs mb-3">
                  <div>
                    <dt className="text-[var(--color-ink-3)]">Product</dt>
                    <dd className="font-medium">{asset?.name ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-ink-3)]">Region</dt>
                    <dd className="tabular">
                      {region
                        ? `${Math.round(region.x * 100)},${Math.round(region.y * 100)} ${Math.round(region.w * 100)}x${Math.round(region.h * 100)} ${region.label ?? ''}`
                        : '—'}
                    </dd>
                  </div>
                </dl>

                {placement.originalPath && (
                  <div className="relative mb-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={mediaUrl(placement.originalPath)}
                      alt=""
                      className="w-full rounded-lg max-h-64 object-contain bg-[var(--color-bg)]"
                    />
                    {region && (
                      <div
                        className="absolute border-2 border-[var(--color-orange)] rounded"
                        style={{
                          left: `${region.x * 100}%`,
                          top: `${region.y * 100}%`,
                          width: `${region.w * 100}%`,
                          height: `${region.h * 100}%`,
                        }}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                )}

                <div className="flex gap-2 mb-3">
                  {placement.originalPath && (
                    <a href={mediaUrl(placement.originalPath)} download className="btn btn-secondary text-xs flex-1">
                      Original
                    </a>
                  )}
                  {asset && (
                    <a href={mediaUrl(asset.storagePath)} download className="btn btn-secondary text-xs flex-1">
                      Asset
                    </a>
                  )}
                </div>

                <GenerationCard placementId={placement.id} />

                <p className="text-xs text-[var(--color-ink-3)] mt-2">
                  Paused since{' '}
                  {placement.clockPausedAt?.toLocaleString('sv-SE') ?? '—'} ·{' '}
                  <Countdown to={placement.deadlineAt.toISOString()} />
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
