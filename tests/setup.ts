import { loadEnv } from '@/lib/env'

loadEnv()

// Forces the fake provider implementations and a deterministic environment so money and
// state tests never touch a network or a real clock.
process.env.NOD_FAKE_PROVIDERS = '1'
process.env.NOD_ENGINE = 'fake'
process.env.TZ = 'Europe/Stockholm'
process.env.BANKID_SUBJECT_SALT ??= 'test-salt-long-enough-to-pass'
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')
process.env.NEXT_PUBLIC_SITE_URL ??= 'http://localhost:3000'

// Point the app's own Prisma client at the test database BEFORE any module imports it.
// This file runs before the test module graph is evaluated, so lib/db.ts constructs its
// client against nod_test and the tests and the code under test share one connection.
const testUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/nod_test?schema=public'
process.env.DATABASE_URL = testUrl
process.env.DIRECT_URL = testUrl
