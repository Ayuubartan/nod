import { afterEach, describe, expect, it, vi } from 'vitest'
import { TikTokProvider } from '@/lib/integrations/tiktok'
import { InstagramProvider, ManualSocialProvider } from '@/lib/integrations/instagram'
import { ProviderError } from '@/lib/integrations/types'

/**
 * Clip ownership + metrics lookups against scripted fetches — docs/14 §3-4. Asserts the
 * request shapes NOD sends (batching, fields, paging) and how provider failures are
 * classified, because the tracking jobs react per ProviderError kind.
 */

type Call = { url: string; init?: RequestInit }
type Scripted = { status?: number; headers?: Record<string, string>; body: unknown }

function scriptFetch(handlers: Array<(call: Call) => Scripted | unknown>) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const call = { url, init }
    calls.push(call)
    const handler = handlers.shift()
    if (!handler) throw new Error(`unexpected fetch ${url}`)
    const out = handler(call)
    const scripted: Scripted =
      out && typeof out === 'object' && 'body' in (out as Scripted) && ('status' in (out as Scripted) || 'headers' in (out as Scripted))
        ? (out as Scripted)
        : { body: out }
    return new Response(JSON.stringify(scripted.body), {
      status: scripted.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(scripted.headers ?? {}) },
    })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const ok = <T,>(data: T) => ({ data, error: { code: 'ok', message: '', log_id: 'x' } })
const nowS = () => Math.floor(Date.now() / 1000)

afterEach(() => vi.unstubAllGlobals())

describe('TikTok clip lookups', () => {
  const provider = new TikTokProvider('key', 'secret', 'https://joinbooga.se/api/auth/tiktok/callback')

  it('resolves an own post through video/query with the metric fields', async () => {
    const created = nowS() - 3600
    const calls = scriptFetch([
      () =>
        ok({
          videos: [
            {
              id: '7234567890123456789',
              create_time: created,
              video_description: 'Reklam #kaffeklubben',
              share_url: 'https://www.tiktok.com/@lisa/video/7234567890123456789',
              view_count: 1500,
              like_count: 120,
              comment_count: 8,
              share_count: 3,
            },
          ],
        }),
    ])

    const lookup = await provider.resolveOwnPost('acc', '7234567890123456789')

    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe('https://open.tiktokapis.com/v2/video/query/')
    expect(url.searchParams.get('fields')).toContain('view_count')
    expect(url.searchParams.get('fields')).toContain('video_description')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ filters: { video_ids: ['7234567890123456789'] } })
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer acc')

    expect(lookup).toEqual({
      status: 'found',
      post: {
        postId: '7234567890123456789',
        providerMediaId: '7234567890123456789',
        caption: 'Reklam #kaffeklubben',
        publishedAt: new Date(created * 1000),
        permalink: 'https://www.tiktok.com/@lisa/video/7234567890123456789',
        views: 1500,
        likes: 120,
        comments: 8,
        shares: 3,
        isPaidPartnership: false,
      },
    })
  })

  it("reports not_found when the video is not among the creator's own", async () => {
    scriptFetch([() => ok({ videos: [] })])
    expect(await provider.resolveOwnPost('acc', '1')).toEqual({ status: 'not_found' })
  })

  it('batches metric pulls 20 ids per request and skips videos without a view count', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `v${i}`)
    const calls = scriptFetch([
      (call) => {
        const body = JSON.parse(call.init!.body as string) as { filters: { video_ids: string[] } }
        return ok({ videos: body.filters.video_ids.map((id) => ({ id, create_time: nowS(), view_count: 10 })) })
      },
      (call) => {
        const body = JSON.parse(call.init!.body as string) as { filters: { video_ids: string[] } }
        return ok({ videos: body.filters.video_ids.map((id, i) => (i === 0 ? { id, create_time: nowS() } : { id, create_time: nowS(), view_count: 5 })) })
      },
    ])

    const metrics = await provider.postMetrics('acc', ids)

    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[0]!.init!.body as string).filters.video_ids).toHaveLength(20)
    expect(JSON.parse(calls[1]!.init!.body as string).filters.video_ids).toEqual(['v20', 'v21', 'v22', 'v23', 'v24'])
    expect(metrics.size).toBe(24)
    expect(metrics.has('v20')).toBe(false)
    expect(metrics.get('v21')?.views).toBe(5)
  })

  it('classifies HTTP 429 with retry-after as rate_limited', async () => {
    scriptFetch([() => ({ status: 429, headers: { 'retry-after': '30' }, body: {} })])
    const error = await provider.postMetrics('acc', ['v1']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe('rate_limited')
    expect((error as ProviderError).retryAfterMs).toBe(30_000)
  })

  it('classifies envelope errors: rate_limit_exceeded, access_token_invalid, other', async () => {
    const envelope = (code: string) => ({ data: {}, error: { code, message: 'x', log_id: 'l' } })
    scriptFetch([() => envelope('rate_limit_exceeded'), () => envelope('access_token_invalid'), () => envelope('internal_error')])
    const kinds: string[] = []
    for (let i = 0; i < 3; i++) {
      const error = await provider.postMetrics('acc', ['v1']).catch((e: unknown) => e)
      kinds.push((error as ProviderError).kind)
    }
    expect(kinds).toEqual(['rate_limited', 'unauthorized', 'transient'])
  })

  it('classifies HTTP 401 as unauthorized and 500 as transient', async () => {
    scriptFetch([() => ({ status: 401, body: {} }), () => ({ status: 502, body: {} })])
    expect(((await provider.postMetrics('acc', ['v1']).catch((e: unknown) => e)) as ProviderError).kind).toBe('unauthorized')
    expect(((await provider.postMetrics('acc', ['v1']).catch((e: unknown) => e)) as ProviderError).kind).toBe('transient')
  })
})

describe('Instagram clip lookups', () => {
  const provider = new InstagramProvider('app', 'secret', 'https://joinbooga.se/api/auth/instagram/callback')
  const media = (id: string, shortcode: string, extra: Record<string, unknown> = {}) => ({
    id,
    shortcode,
    caption: 'Reklam #kaffeklubben',
    media_type: 'VIDEO',
    media_product_type: 'REELS',
    permalink: `https://www.instagram.com/reel/${shortcode}/`,
    timestamp: '2026-09-08T10:00:00+0000',
    like_count: 40,
    comments_count: 4,
    ...extra,
  })
  const insights = (views: number) => ({ data: [{ name: 'views', values: [{ value: views }] }, { name: 'reach', values: [{ value: 1 }] }] })

  it('pages /me/media until the shortcode appears, then reads views from insights', async () => {
    const calls = scriptFetch([
      () => ({ data: [media('1', 'AAA')], paging: { next: 'https://graph.instagram.com/me/media?after=cursor1&access_token=acc' } }),
      () => ({ data: [media('2', 'BBB'), media('3', 'CCC')] }),
      () => insights(900),
    ])

    const lookup = await provider.resolveOwnPost('acc', 'CCC')

    expect(calls[0]!.url).toContain('/me/media?fields=id,shortcode,caption')
    expect(calls[0]!.url).toContain('limit=50')
    expect(calls[1]!.url).toContain('after=cursor1')
    expect(calls[2]!.url).toContain('/3/insights?metric=views,reach')
    expect(lookup).toEqual({
      status: 'found',
      post: {
        postId: 'CCC',
        providerMediaId: '3',
        caption: 'Reklam #kaffeklubben',
        publishedAt: new Date('2026-09-08T10:00:00+0000'),
        permalink: 'https://www.instagram.com/reel/CCC/',
        views: 900,
        likes: 40,
        comments: 4,
        shares: null,
        isPaidPartnership: false,
      },
    })
  })

  it('gives up after four pages (the last ~200 posts) and reports not_found', async () => {
    const page = (n: number) => () => ({
      data: [media(`${n}`, `S${n}`)],
      paging: { next: `https://graph.instagram.com/me/media?after=c${n}&access_token=acc` },
    })
    const calls = scriptFetch([page(1), page(2), page(3), page(4), page(5)])
    expect(await provider.resolveOwnPost('acc', 'ZZZ')).toEqual({ status: 'not_found' })
    expect(calls).toHaveLength(4)
  })

  it('reads metrics per media id and treats "object does not exist" (code 100) as a miss', async () => {
    const calls = scriptFetch([
      () => media('10', 'AAA'),
      () => insights(50),
      () => ({ status: 400, body: { error: { message: 'Unsupported get request', code: 100 } } }),
    ])

    const metrics = await provider.postMetrics('acc', ['10', '11'])

    expect(calls[0]!.url).toContain('/10?fields=')
    expect(calls[2]!.url).toContain('/11?fields=')
    expect([...metrics.keys()]).toEqual(['10'])
    expect(metrics.get('10')?.views).toBe(50)
  })

  it('classifies Graph errors: throttling codes → rate_limited, 190 → unauthorized, else transient', async () => {
    scriptFetch([
      () => ({ status: 400, body: { error: { code: 4 } } }),
      () => ({ status: 400, body: { error: { code: 190 } } }),
      () => ({ status: 500, body: 'oops' }),
      () => ({ status: 429, headers: { 'retry-after': '10' }, body: {} }),
    ])
    const kind = async () => ((await provider.postMetrics('acc', ['1']).catch((e: unknown) => e)) as ProviderError)
    expect((await kind()).kind).toBe('rate_limited')
    expect((await kind()).kind).toBe('unauthorized')
    expect((await kind()).kind).toBe('transient')
    const throttled = await kind()
    expect(throttled.kind).toBe('rate_limited')
    expect(throttled.retryAfterMs).toBe(10_000)
  })
})

describe('Manual provider', () => {
  it('cannot prove ownership and returns no metrics', async () => {
    const provider = new ManualSocialProvider()
    expect(await provider.resolveOwnPost()).toEqual({ status: 'not_found' })
    expect((await provider.postMetrics()).size).toBe(0)
  })
})
