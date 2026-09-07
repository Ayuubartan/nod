/**
 * Media storage — docs/08. Originals, generated versions and screenshots.
 *
 * Everything is private: media is served through signed URLs or the authorised
 * /api/media proxy, never a public bucket, because a participant's original photo is
 * their own unpublished content.
 *
 * Three backends, chosen by which keys exist:
 *   - Supabase Storage  (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *   - Vercel Blob       (BLOB_READ_WRITE_TOKEN)
 *   - .storage/ on disk (nothing set) so the whole flow is walkable locally
 *     (docs/08: "Fakes activate when a provider key is absent")
 *
 * DECISION: Vercel Blob is here because the demo deploy runs on Vercel + Neon, which
 * has no file storage, and a blob store is one CLI command away. Reads always go
 * through /api/media, so the access rules there apply regardless of backend. The store
 * itself is private or public at creation time (the CLI can only create public ones;
 * the dashboard offers private) and the SDK must be told which: BLOB_ACCESS=public
 * for a store the CLI made — the blob URLs are then reachable by anyone holding a
 * placement id, acceptable for a demo with fake providers, not for a pilot. Supabase
 * stays the pilot choice (docs/08): it can serve resized signed URLs, Blob cannot.
 */

import 'server-only'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { del as blobDel, get as blobGet, put as blobPut } from '@vercel/blob'

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'nod-media'
const LOCAL_ROOT = '.storage'

type Backend = 'supabase' | 'blob' | 'local'

export function backend(): Backend {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return 'supabase'
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob'
  return 'local'
}

const isConfigured = () => backend() === 'supabase'

const blobAccess = () => (process.env.BLOB_ACCESS === 'public' ? 'public' : 'private')

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export type StoragePath = string

/** Deterministic paths, so retention jobs can find what they need to delete. */
export const paths = {
  original: (placementId: string, ext: string) => `originals/${placementId}.${ext}`,
  version: (placementId: string, versionId: string, ext: string) =>
    `versions/${placementId}/${versionId}.${ext}`,
  screenshot: (placementId: string, ext: string) => `screenshots/${placementId}.${ext}`,
  asset: (campaignId: string, assetId: string, ext: string) => `assets/${campaignId}/${assetId}.${ext}`,
  report: (campaignId: string) => `reports/${campaignId}.pdf`,
  export: (userId: string, at: string) => `exports/${userId}/${at}.json`,
}

export async function put(
  path: StoragePath,
  body: Buffer,
  contentType: string,
): Promise<StoragePath> {
  if (backend() === 'local') {
    const file = join(process.cwd(), LOCAL_ROOT, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body)
    return path
  }

  if (backend() === 'blob') {
    // Deterministic paths (see `paths`) are the contract, so no random suffix, and a
    // re-render of the same version overwrites in place.
    await blobPut(path, body, { access: blobAccess(), contentType, addRandomSuffix: false, allowOverwrite: true })
    return path
  }

  const { error } = await serviceClient()
    .storage.from(BUCKET)
    .upload(path, body, { contentType, upsert: true })

  if (error) throw new Error(`Storage upload failed: ${error.message}`)
  return path
}

export async function get(path: StoragePath): Promise<Buffer> {
  if (backend() === 'local') {
    return readFile(join(process.cwd(), LOCAL_ROOT, path))
  }

  if (backend() === 'blob') {
    const result = await blobGet(path, { access: blobAccess() })
    if (!result?.stream) throw new Error(`Storage download failed: ${path} not found`)
    return Buffer.from(await new Response(result.stream).arrayBuffer())
  }

  const { data, error } = await serviceClient().storage.from(BUCKET).download(path)
  if (error || !data) throw new Error(`Storage download failed: ${error?.message}`)
  return Buffer.from(await data.arrayBuffer())
}

export async function remove(path: StoragePath): Promise<void> {
  if (backend() === 'local') return
  if (backend() === 'blob') {
    await blobDel(path)
    return
  }
  await serviceClient().storage.from(BUCKET).remove([path])
}

/**
 * A short-lived signed URL. Media is never public. Only Supabase can sign; the other
 * backends go through the authorised proxy.
 */
export async function signedUrl(path: StoragePath, expiresInSeconds = 3600): Promise<string> {
  if (!isConfigured()) return `/api/media/${encodeURIComponent(path)}`

  const { data, error } = await serviceClient()
    .storage.from(BUCKET)
    .createSignedUrl(path, expiresInSeconds, {
      // Supabase image transforms: serve a phone-sized image, not the original
      // (docs/02 Performance: "Images served resized via Supabase transforms").
      transform: { width: 1080, quality: 80 },
    })

  if (error || !data) return `/api/media/${encodeURIComponent(path)}`
  return data.signedUrl
}

// The URL a client component renders lives in lib/media-url.ts, which has no Node
// imports, and is re-exported here for server callers.
export { mediaUrl } from './media-url'

export function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
    'application/json': 'json',
  }
  return map[mimeType] ?? 'bin'
}
