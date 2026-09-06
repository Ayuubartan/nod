/**
 * Training export — docs/06 section 6, docs/09 M5 task 6.
 *
 * "Every render writes a PlacementVersion; every participant action on it writes a
 *  PlacementEvent. That stream — filtered to trainingConsent = true and anonymised — is
 *  the training export job."
 *
 * Two rules this job exists to enforce:
 *   - only participants who ticked the separate, unbundled consent box are included
 *   - nothing that identifies a person leaves with the data
 *
 * Consent is re-checked at export time, not at capture time, so revoking it in Settings
 * stops future exports (docs/07 section 2).
 */

import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'
import { inngest } from '@/lib/events'
import { paths, put } from '@/lib/storage'

/**
 * A stable but non-reversible per-export identifier. Salted with the export id so the
 * same participant is consistent inside one export and uncorrelatable across exports.
 */
function pseudonym(id: string, exportId: string): string {
  return createHash('sha256').update(`${id}:${exportId}`).digest('hex').slice(0, 16)
}

export type TrainingRecord = {
  placement: string
  participant: string
  contentType: string | null
  /** The surface the participant chose, and what the engine had offered. */
  region: unknown
  candidates: unknown
  assetType: string | null
  regenerations: number
  /** The label: did the participant accept this placement, and did the brand? */
  participantApproved: boolean
  brandApproved: boolean
  rejectReason: string | null
  /** The outcome signal: how the placement actually performed. */
  qualifiedViews: number | null
  events: Array<{ type: string; payload: unknown; atOffsetMs: number }>
}

export async function buildTrainingExport(exportId: string): Promise<TrainingRecord[]> {
  const placements = await prisma.placement.findMany({
    where: {
      deletedAt: null,
      // Consent is checked here, at export time.
      user: { trainingConsent: true, deletedAt: null },
      // Only placements that reached a decision carry a usable label.
      state: { in: ['PAID', 'REJECTED', 'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND'] },
    },
    include: {
      events: { orderBy: { createdAt: 'asc' } },
      verification: { select: { qualifiedViews: true } },
      campaign: { select: { assets: { select: { id: true, placementTypes: true } } } },
    },
    take: 10_000,
  })

  return placements.map((placement) => {
    const candidatesEvent = placement.events.find((e) => e.type === 'REGION_PICKED')
    const asset = placement.campaign.assets.find((a) => a.id === placement.assetId)
    const start = placement.claimedAt.getTime()

    return {
      placement: pseudonym(placement.id, exportId),
      participant: pseudonym(placement.userId, exportId),
      contentType: placement.contentType,
      region: placement.regionJson,
      candidates: (candidatesEvent?.payload as { candidates?: unknown } | null)?.candidates ?? null,
      // The asset's type, never its name — a product name identifies the brand.
      assetType: asset?.placementTypes[0] ?? null,
      regenerations: placement.regenCount,
      participantApproved: placement.events.some((e) => e.type === 'APPROVE'),
      brandApproved: placement.state === 'PAID' || placement.state === 'REJECTED',
      rejectReason: placement.rejectReason,
      qualifiedViews: placement.verification?.qualifiedViews ?? null,
      events: placement.events.map((event) => ({
        type: event.type,
        payload: event.payload,
        // Relative timing only: an absolute timestamp is a re-identification vector.
        atOffsetMs: event.createdAt.getTime() - start,
      })),
    }
  })
}

/**
 * Weekly export to the training bucket. It writes a file and nothing else — no model is
 * trained here, and the data never leaves NOD's own storage.
 */
export const trainingExport = inngest.createFunction(
  { id: 'training-export', name: 'Training data export (consented, anonymised)' },
  { cron: '0 3 * * 0' },
  async ({ step }) => {
    const exportId = new Date().toISOString().slice(0, 10)

    const records = await step.run('build', () => buildTrainingExport(exportId))
    if (records.length === 0) return { records: 0 }

    const path = await step.run('write', async () => {
      const body = Buffer.from(records.map((r) => JSON.stringify(r)).join('\n'), 'utf8')
      return put(`training/${exportId}.jsonl`, body, 'application/x-ndjson')
    })

    return { records: records.length, path }
  },
)

export { paths }
