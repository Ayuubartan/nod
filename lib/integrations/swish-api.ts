/**
 * Swish Payouts API — docs/06 section 5, docs/09 M5 task 3.
 *
 * "Later: Swish Payouts API (requires bank agreement + certificate). Same interface:
 *  PayoutProvider { send(batch) → results[] }."
 *
 * Two things make payouts different from every other integration in this codebase:
 *
 *   1. It is mutual TLS. Swish authenticates NOD with a client certificate issued by
 *      the bank, not an API key. That means a real https.Agent, which is why this lives
 *      in its own file rather than in swish.ts — nothing else needs `node:https`.
 *
 *   2. A payout that times out is not a payout that failed. Retrying blindly can pay
 *      someone twice. So every request carries a deterministic instruction id derived
 *      from the batch and the wallet, and an ambiguous result is reported as PENDING for
 *      a human to reconcile — never silently retried.
 *
 * VERIFIED: not yet against Swish's live Payouts specification. docs/06 requires reading
 * the current reference and recording the date and URL here before this is enabled.
 * The endpoint and certificate paths are configuration, so that check is a config
 * change rather than a rewrite.
 */

import 'server-only'
import { createHash, createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PayoutProvider, PayoutResult, PayoutRow } from './types'

type SwishConfig = {
  endpoint: string
  payerAlias: string
  certPath: string
  keyPath: string
  caPath?: string
  passphrase?: string
  signingKeyPath?: string
  signingCertSerial?: string
}

function readConfig(): SwishConfig | null {
  const endpoint = process.env.SWISH_ENDPOINT
  const payerAlias = process.env.SWISH_PAYER_ALIAS
  const certPath = process.env.SWISH_CERT_PATH
  const keyPath = process.env.SWISH_KEY_PATH

  if (!endpoint || !payerAlias || !certPath || !keyPath) return null

  return {
    endpoint,
    payerAlias,
    certPath,
    keyPath,
    caPath: process.env.SWISH_CA_PATH,
    passphrase: process.env.SWISH_CERT_PASSPHRASE,
    signingKeyPath: process.env.SWISH_SIGNING_KEY_PATH,
    signingCertSerial: process.env.SWISH_SIGNING_CERT_SERIAL,
  }
}

/**
 * A stable instruction id for one wallet in one batch.
 *
 * Swish requires an UUID-shaped identifier that is unique per payout. Deriving it from
 * (batchId, walletId) rather than generating it randomly means a retry of the same
 * logical payout reuses the same id, so Swish itself rejects the duplicate instead of
 * paying twice.
 */
export function instructionId(batchId: string, walletId: string): string {
  const hash = createHash('sha256').update(`${batchId}:${walletId}`).digest('hex')
  return hash.slice(0, 32).toUpperCase()
}

/**
 * Swish signs the payout payload with a separate signing certificate, so a compromised
 * TLS client certificate alone cannot move money.
 */
function signPayload(payload: string, config: SwishConfig): string {
  if (!config.signingKeyPath) throw new Error('SWISH_SIGNING_KEY_PATH is required for payouts')
  const key = readFileSync(config.signingKeyPath, 'utf8')
  const signer = createSign('RSA-SHA512')
  signer.update(payload)
  signer.end()
  return signer.sign(key, 'base64')
}

export class SwishPayoutsProvider implements PayoutProvider {
  readonly name = 'swish-api'

  static isConfigured(): boolean {
    return readConfig() !== null
  }

  async send(batchId: string, rows: PayoutRow[]): Promise<PayoutResult[]> {
    const config = readConfig()
    if (!config) {
      throw new Error(
        'Swish Payouts is not configured. It needs a bank agreement and a client certificate (docs/06 section 5).',
      )
    }

    // Node's fetch cannot do client certificates, so payouts use https directly.
    const { Agent } = await import('node:https')
    const agent = new Agent({
      cert: readFileSync(config.certPath),
      key: readFileSync(config.keyPath),
      ...(config.caPath ? { ca: readFileSync(config.caPath) } : {}),
      ...(config.passphrase ? { passphrase: config.passphrase } : {}),
      keepAlive: true,
    })

    const results: PayoutResult[] = []

    // Sent one at a time on purpose: a partial failure inside a bulk call is far harder
    // to reconcile than a sequence of individually-identified instructions, and a pilot
    // batch is tens of rows, not thousands.
    for (const row of rows) {
      const id = instructionId(batchId, row.walletId)

      const payload = JSON.stringify({
        payoutInstructionUUID: id,
        payerPaymentReference: `NOD-${batchId}`,
        payerAlias: config.payerAlias,
        payeeAlias: row.swishNumber,
        payeeSSN: undefined, // NOD does not hold a personnummer and never sends one.
        amount: (row.amountOre / 100).toFixed(2),
        currency: 'SEK',
        payoutType: 'PAYOUT',
        message: row.memo.slice(0, 50),
        instructionDate: new Date().toISOString(),
        signingCertificateSerialNumber: config.signingCertSerial,
      })

      try {
        const result = await this.post(config, agent, id, payload)
        results.push({ walletId: row.walletId, ok: true, reference: result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // An ambiguous outcome must never be auto-retried: it goes to the ops queue.
        const ambiguous = /timeout|ECONNRESET|socket hang up|50\d/i.test(message)
        results.push({
          walletId: row.walletId,
          ok: false,
          error: ambiguous ? `PENDING_MANUAL_CHECK: ${message}` : message,
          reference: ambiguous ? id : undefined,
        })
      }
    }

    agent.destroy()
    return results
  }

  private post(
    config: SwishConfig,
    agent: import('node:https').Agent,
    id: string,
    payload: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      void import('node:https').then(({ request }) => {
        const url = new URL(`${config.endpoint.replace(/\/$/, '')}/swish-cpcapi/api/v1/payouts`)
        const body = JSON.stringify({ payload: JSON.parse(payload), callbackUrl: process.env.SWISH_CALLBACK_URL, signature: signPayload(payload, config) })

        const req = request(
          {
            method: 'POST',
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            agent,
            timeout: 30_000,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              const status = res.statusCode ?? 0
              if (status >= 200 && status < 300) {
                // Swish returns the instruction location; the id is our reference.
                resolve(res.headers.location?.split('/').pop() ?? id)
              } else {
                reject(new Error(`Swish payout failed: ${status} ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`))
              }
            })
          },
        )

        req.on('timeout', () => req.destroy(new Error('Swish payout request timeout')))
        req.on('error', reject)
        req.end(body)
      }, reject)
    })
  }
}
