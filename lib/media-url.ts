/**
 * Client-safe media URL helper.
 *
 * Deliberately separate from lib/storage.ts: that module touches node:fs and the
 * Supabase service-role key, so importing it from a client component would both break
 * the bundle and pull a server secret into scope. This file has no imports at all.
 */
export function mediaUrl(path: string | null | undefined): string {
  if (!path) return ''
  return `/api/media/${encodeURIComponent(path)}`
}
