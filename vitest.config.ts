import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The "@/..." alias mirrors tsconfig paths. Set here rather than via vite-tsconfig-paths
// so the config file stays CJS-loadable by esbuild.
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': root.replace(/[\\/]$/, ''),
      // `server-only` throws when Vitest resolves its client entry. Server modules are
      // exactly what these tests exercise, so map it to a no-op.
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests share one Postgres database and truncate between tests, so
    // they must not run concurrently in separate workers.
    fileParallelism: false,
    sequence: { concurrent: false },
    coverage: {
      provider: 'v8',
      include: ['lib/money/**', 'lib/state/**'],
      thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 },
    },
  },
})
