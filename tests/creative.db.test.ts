/**
 * Direct placement and the creative distribution layer.
 *
 *   - confirming a position renders straight to PARTICIPANT_REVIEW (no ops queue)
 *   - the ops kill switch (`engine.autoRender`) puts renders back on the queue
 *   - a brand swapping its creative re-renders in-flight placements without touching
 *     anything a participant has approved, and without spending their regenerations
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, makeBrand, makeCampaign, makeParticipant, resetDb } from './helpers/db'
import { claim, participantApprove, position, upload } from '@/lib/state/placement'
import { generate, renderPlacement } from '@/lib/render'
import { CreativeError, inFlightByAsset, replaceCreative } from '@/lib/creative'
import { setFlag } from '@/lib/flags'
import { eventsOfType } from '@/lib/events'

const PARTICIPANT = { kind: 'PARTICIPANT' as const, id: 'test' }
const BRAND = { kind: 'BRAND' as const, id: 'brand-user' }

beforeEach(resetDb)
afterAll(async () => {
  await db.$disconnect()
})

async function positioned(campaign: Awaited<ReturnType<typeof makeCampaign>>, hash: string) {
  const { user, account } = await makeParticipant({ avgViews30d: 450 })
  const claimed = await claim({ campaignId: campaign.id, userId: user.id, socialAccountId: account.id })
  await upload(
    { placementId: claimed.id, storagePath: 'test/original.jpg', perceptualHash: hash.padEnd(16, '0'), contentType: 'post' },
    PARTICIPANT,
  )
  await position(claimed.id, { region: { x: 0.1, y: 0.5, w: 0.3, h: 0.3 }, assetId: campaign.assets[0]!.id }, PARTICIPANT)
  return claimed.id
}

async function state(id: string) {
  return db.placement.findUniqueOrThrow({ where: { id }, select: { state: true, regenCount: true, assetId: true } })
}

describe('direct placement', () => {
  it('renders straight through to PARTICIPANT_REVIEW with a version on file', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const id = await positioned(campaign, 'a')

    expect(await generate(id, PARTICIPANT)).toBe('rendered')

    const after = await state(id)
    expect(after.state).toBe('PARTICIPANT_REVIEW')
    const versions = await db.placementVersion.findMany({ where: { placementId: id } })
    expect(versions).toHaveLength(1)
    expect(versions[0]!.engine).toBe('fake')
    expect(eventsOfType('placement/generated')).toHaveLength(1)
  })

  it('defers to the ops queue when autoRender is switched off', async () => {
    await setFlag('engine.autoRender', false)
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const id = await positioned(campaign, 'b')

    expect(await generate(id, PARTICIPANT)).toBe('deferred')
    expect((await state(id)).state).toBe('GENERATING')
    expect(await db.placementVersion.count({ where: { placementId: id } })).toBe(0)

    // Ops turn it back on and press "run engine": the same placement renders.
    await setFlag('engine.autoRender', true)
    expect(await renderPlacement(id)).toBe('rendered')
    expect((await state(id)).state).toBe('PARTICIPANT_REVIEW')
  })

  it('fails cleanly when the position lost its asset', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const id = await positioned(campaign, 'c')
    await db.placement.update({ where: { id }, data: { assetId: null } })

    expect(await generate(id, PARTICIPANT)).toBe('failed')
    expect((await state(id)).state).toBe('GENERATION_FAILED')
  })

  it('does nothing for a placement that is not GENERATING', async () => {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const id = await positioned(campaign, 'd')
    expect(await renderPlacement(id)).toBe('skipped')
  })
})

describe('creative swap — the distribution layer', () => {
  async function campaignWithTwoAssets() {
    const brand = await makeBrand()
    const campaign = await makeCampaign({ brandId: brand.id })
    const winter = await db.campaignAsset.create({
      data: { campaignId: campaign.id, name: 'Winter', storagePath: 'test/winter.png', placementTypes: ['product'] },
    })
    return { brand, campaign, autumn: campaign.assets[0]!, winter }
  }

  it('re-renders in-flight placements with the new asset and leaves approved ones alone', async () => {
    const { campaign, autumn, winter } = await campaignWithTwoAssets()

    const inReview = await positioned(campaign, 'e')
    await generate(inReview, PARTICIPANT)

    const approved = await positioned(campaign, 'f')
    await generate(approved, PARTICIPANT)
    await participantApprove(approved, PARTICIPANT, { sampleRoll: 0.99 })

    const stillPositioned = await positioned(campaign, 'g')

    expect(await inFlightByAsset(campaign.id)).toEqual(new Map([[autumn.id, 2]]))

    const result = await replaceCreative({ campaignId: campaign.id, fromAssetId: autumn.id, toAssetId: winter.id, actor: BRAND })
    expect(result).toMatchObject({ reRendered: 2, deferred: 0, failed: 0 })

    expect(await state(inReview)).toMatchObject({ state: 'PARTICIPANT_REVIEW', assetId: winter.id, regenCount: 0 })
    expect(await state(stillPositioned)).toMatchObject({ state: 'PARTICIPANT_REVIEW', assetId: winter.id })
    expect(await state(approved)).toMatchObject({ state: 'BRAND_REVIEW', assetId: autumn.id })

    // The old creative is retired, softly.
    const retired = await db.campaignAsset.findUniqueOrThrow({ where: { id: autumn.id } })
    expect(retired.deletedAt).not.toBeNull()

    // The swap is on the training stream as a SWAP, not as the participant regenerating.
    const events = await db.placementEvent.findMany({ where: { placementId: inReview, type: 'SWAP' } })
    expect(events).toHaveLength(1)
    expect(await db.placementVersion.count({ where: { placementId: inReview } })).toBe(2)

    const audit = await db.auditLog.findMany({ where: { entity: 'CampaignAsset', entityId: autumn.id } })
    expect(audit.map((a) => a.event)).toContain('RETIRE')
  })

  it('refuses a swap to the same asset or across campaigns', async () => {
    const { campaign, autumn, winter } = await campaignWithTwoAssets()
    const other = await makeCampaign({ brandId: campaign.brandId })

    await expect(
      replaceCreative({ campaignId: campaign.id, fromAssetId: autumn.id, toAssetId: autumn.id, actor: BRAND }),
    ).rejects.toBeInstanceOf(CreativeError)
    await expect(
      replaceCreative({ campaignId: campaign.id, fromAssetId: autumn.id, toAssetId: other.assets[0]!.id, actor: BRAND }),
    ).rejects.toMatchObject({ code: 'DIFFERENT_CAMPAIGN' })
    expect(winter.deletedAt).toBeNull()
  })
})
