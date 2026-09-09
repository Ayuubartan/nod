import { prisma } from '@/lib/db'
import { requireOps } from '@/lib/auth'
import { formatOre } from '@/lib/money/calc'
import { SubmissionActions } from '@/components/ops/SubmissionActions'
import { ClipCampaignControls } from '@/components/ops/ClipCampaignControls'

/**
 * Clip queue — docs/14 §5/§6.
 *
 * Sections in the order ops should work them:
 *   1. HELD — validation flagged the clip; approve on the recorded numbers or reject
 *   2. VALIDATING for more than 24h — the window-end job did not settle it
 *   3. RECEIVED / FIX_DISCLOSURE for more than 1h — ownership verification is stuck
 *   4. open clip campaigns with their join / submission doors
 */
export const dynamic = 'force-dynamic'

const HOUR = 60 * 60 * 1000

const submissionInclude = {
  account: { select: { handle: true, followers: true } },
  campaign: { select: { id: true, name: true, brand: { select: { name: true } } } },
} as const

export default async function OpsSubmissionsPage() {
  await requireOps()
  const now = Date.now()

  const [held, stuckValidating, stuckReceived, campaigns] = await Promise.all([
    prisma.submission.findMany({
      where: { state: 'HELD', deletedAt: null },
      include: submissionInclude,
      orderBy: { validationEndsAt: 'asc' },
      take: 50,
    }),
    prisma.submission.findMany({
      where: { state: 'VALIDATING', deletedAt: null, validationEndsAt: { lt: new Date(now - 24 * HOUR) } },
      include: submissionInclude,
      orderBy: { validationEndsAt: 'asc' },
      take: 50,
    }),
    prisma.submission.findMany({
      where: { state: { in: ['RECEIVED', 'FIX_DISCLOSURE'] }, deletedAt: null, submittedAt: { lt: new Date(now - HOUR) } },
      include: submissionInclude,
      orderBy: { submittedAt: 'asc' },
      take: 50,
    }),
    prisma.campaign.findMany({
      where: { kind: 'CLIP', deletedAt: null, state: { in: ['LIVE', 'FILLING', 'EXHAUSTED'] } },
      select: {
        id: true,
        name: true,
        state: true,
        joinsPausedAt: true,
        submissionsPausedAt: true,
        brand: { select: { name: true } },
        _count: {
          select: {
            memberships: { where: { state: 'JOINED', deletedAt: null } },
            submissions: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    }),
  ])

  type Row = (typeof held)[number]
  const nf = (n: number) => n.toLocaleString('sv-SE')

  const Section = ({ title, hint, rows, empty }: { title: string; hint?: string; rows: Row[]; empty: string }) => (
    <section>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-xl">{title}</h2>
        <p className="text-sm text-[var(--color-ink-2)] tabular">
          {rows.length}
          {hint ? ` · ${hint}` : ''}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="card p-6 text-center text-sm text-[var(--color-ink-3)]">{empty}</p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {rows.map((s) => (
            <li key={s.id} className="card p-4 grid gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    @{s.account.handle} <span className="text-[var(--color-ink-3)] font-normal">· {s.platform}</span>
                  </p>
                  <p className="text-xs text-[var(--color-ink-2)]">
                    {s.campaign.brand.name} · {s.campaign.name}
                  </p>
                </div>
                <span className="chip text-xs">{s.state}</span>
              </div>

              <dl className="grid grid-cols-3 gap-2 text-xs tabular">
                <div>
                  <dt className="text-[var(--color-ink-3)]">Views</dt>
                  <dd>{s.latestViews === null ? '-' : nf(s.latestViews)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-ink-3)]">Eligible</dt>
                  <dd className="font-semibold">{nf(s.eligibleViews)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-ink-3)]">Reserved</dt>
                  <dd>{s.budgetExhausted ? 'not payable' : formatOre(s.reservationOre)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-ink-3)]">Followers</dt>
                  <dd>{nf(s.account.followers)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-ink-3)]">Submitted</dt>
                  <dd>{s.submittedAt.toLocaleString('sv-SE')}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-ink-3)]">Risk</dt>
                  <dd>{s.riskScore === null ? '-' : s.riskScore}</dd>
                </div>
              </dl>

              {s.riskFactors.length > 0 && <p className="text-xs text-[var(--color-ink-2)]">{s.riskFactors.join(' · ')}</p>}

              <a
                href={s.canonicalUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs underline text-[var(--color-blue)] break-all"
              >
                {s.canonicalUrl}
              </a>

              <SubmissionActions submissionId={s.id} state={s.state} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  return (
    <div className="grid gap-10">
      <div>
        <h1 className="text-xl mb-1">Clips</h1>
        <p className="text-sm text-[var(--color-ink-2)]">
          Held clips first. Disclosure cannot be waived: a clip that failed it is already rejected.
        </p>
      </div>

      <Section title="Held for review" rows={held} empty="Nothing held." />
      <Section title="Validating > 24h" hint="window-end job did not settle" rows={stuckValidating} empty="Nothing stuck." />
      <Section title="Verification > 1h" hint="ownership check pending" rows={stuckReceived} empty="Nothing pending." />

      <section>
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-xl">Open clip campaigns</h2>
          <p className="text-sm text-[var(--color-ink-2)] tabular">{campaigns.length}</p>
        </div>
        {campaigns.length === 0 ? (
          <p className="card p-6 text-center text-sm text-[var(--color-ink-3)]">No open clip campaigns.</p>
        ) : (
          <ul className="grid gap-3">
            {campaigns.map((c) => (
              <li key={c.id} className="card p-4 grid gap-3">
                <div>
                  <p className="font-semibold">
                    {c.brand.name} · {c.name}
                  </p>
                  <p className="text-xs text-[var(--color-ink-2)] tabular">
                    {c.state} · {nf(c._count.memberships)} members · {nf(c._count.submissions)} clips
                    {c.joinsPausedAt && ' · joins paused'}
                    {c.submissionsPausedAt && ' · submissions paused'}
                  </p>
                </div>
                <ClipCampaignControls
                  campaignId={c.id}
                  joinsPaused={c.joinsPausedAt !== null}
                  submissionsPaused={c.submissionsPausedAt !== null}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
