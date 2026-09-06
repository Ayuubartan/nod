/**
 * Loads .env for scripts and tests that run outside Next.js (seed, vitest, Inngest CLI).
 * Next.js loads .env itself, so this is a no-op there.
 */
import { existsSync } from 'node:fs'

let loaded = false

export function loadEnv(): void {
  if (loaded || process.env.NEXT_RUNTIME) return
  loaded = true
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file)
      } catch {
        // Node < 20.6 has no loadEnvFile; the CI workflow sets env vars directly.
      }
    }
  }
}
