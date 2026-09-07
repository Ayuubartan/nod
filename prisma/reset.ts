/**
 * Development reset — drops all rows and re-seeds.
 *
 * Exists because exercising the product locally leaves real consequences behind:
 * a rejected placement strikes and flags its participant, a claim reserves budget,
 * and both are supposed to persist. This puts the demo data back to a known state.
 *
 * Refuses to run against anything that is not a local database.
 */

import { PrismaClient } from '@prisma/client'
import { loadEnv } from '../lib/env'

loadEnv()

const prisma = new PrismaClient()

const TABLES = [
  'LedgerEntry', 'ViewSnapshot', 'Verification', 'Dispute', 'PlacementEvent',
  'PlacementVersion', 'Placement', 'CampaignAsset', 'PayoutTemplate', 'Campaign',
  'BrandUser', 'Brand', 'PayoutBatch', 'Wallet', 'Strike', 'Referral', 'Identity',
  'SocialAccount', 'User', 'AuditLog', 'Flag', 'WaitlistEntry', 'BrandEnquiry',
  'IdempotencyKey',
]

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1')

  if (!isLocal) {
    console.error(`Refusing to reset a non-local database: ${url.replace(/:[^:@]*@/, ':***@')}`)
    process.exitCode = 1
    return
  }

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  )
  console.info(`Truncated ${TABLES.length} tables.`)
  await prisma.$disconnect()

  // Re-seed in a child process so the seed script owns its own client lifecycle.
  const { execFileSync } = await import('node:child_process')
  execFileSync('pnpm', ['tsx', '--conditions=react-server', 'prisma/seed.ts'], { stdio: 'inherit', shell: true })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
