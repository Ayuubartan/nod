/**
 * Supabase Storage — docs/08. Originals, generated versions and screenshots.
 *
 * Everything is private: media is served through signed URLs, never a public bucket,
 * because a participant's original photo is their own unpublished content.
 *
 * With no Supabase project configured, files are written under .storage/ so the whole
 * flow is walkable locally (docs/08: "Fakes activate when a provider key is absent").
 */

import 'server-only'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'nod-media'
const LOCAL_ROOT = '.storage'

const isConfigured = () =>
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)

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
  if (!isConfigured()) {
    const file = join(process.cwd(), LOCAL_ROOT, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body)
    return path
  }

  const { error } = await serviceClient()
    .storage.from(BUCKET)
    .upload(path, body, { contentType, upsert: true })

  if (error) throw new Error(`Storage upload failed: ${error.message}`)
  return path
}

export async function get(path: StoragePath): Promise<Buffer> {
  if (!isConfigured()) {
    return readFile(join(process.cwd(), LOCAL_ROOT, path))
  }

  const { data, error } = await serviceClient().storage.from(BUCKET).download(path)
  if (error || !data) throw new Error(`Storage download failed: ${error?.message}`)
  return Buffer.from(await data.arrayBuffer())
}

export async function remove(path: StoragePath): Promise<void> {
  if (!isConfigured()) return
  await serviceClient().storage.from(BUCKET).remove([path])
}

/** A short-lived signed URL. Media is never public. */
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
