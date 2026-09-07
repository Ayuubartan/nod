/**
 * Copies everything under .storage/ to the storage backend the environment points at
 * (Supabase or Vercel Blob). One-off, for when a database was seeded or rendered on
 * this machine and the deploy that reads it has no file storage of its own — the
 * placement rows already exist, only the bytes are missing.
 *
 *   pnpm storage:push            (needs BLOB_READ_WRITE_TOKEN or the Supabase keys)
 *
 * Idempotent: uploads overwrite in place.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { loadEnv } from '../lib/env'

loadEnv()

const ROOT = join(process.cwd(), '.storage')

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  json: 'application/json',
}

async function main() {
  const storage = await import('../lib/storage')
  const backend = storage.backend()
  if (backend === 'local') {
    console.error('No remote storage configured (BLOB_READ_WRITE_TOKEN or SUPABASE_* missing); nothing to push.')
    process.exit(1)
  }

  const files = (await readdir(ROOT, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))

  console.info(`Pushing ${files.length} files from .storage/ to ${backend}…`)
  for (const file of files) {
    const path = relative(ROOT, file).split(sep).join('/')
    const ext = path.split('.').pop() ?? ''
    await storage.put(path, await readFile(file), TYPES[ext] ?? 'application/octet-stream')
    console.info(`  ${path}`)
  }
  console.info('Done.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
