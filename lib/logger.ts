/**
 * Structured logging — docs/08 Observability:
 * "Structured JSON logs with requestId, userId, placementId."
 *
 * Everything goes through `scrubValue`, so a personnummer or a token cannot reach the
 * log even if a caller passes an error object that happens to contain one. That is the
 * whole reason this exists rather than bare `console.log`.
 *
 * Request context is carried in AsyncLocalStorage so a Server Action deep in the stack
 * does not have to thread a requestId through every call.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { scrubValue } from './scrub'

export type LogContext = {
  requestId?: string
  userId?: string
  brandId?: string
  placementId?: string
  campaignId?: string
  route?: string
}

const store = new AsyncLocalStorage<LogContext>()

/** Runs `fn` with this context attached to every log line it produces. */
export function withContext<T>(context: LogContext, fn: () => T): T {
  const parent = store.getStore() ?? {}
  return store.run({ ...parent, ...context }, fn)
}

/** Adds to the current context without opening a new scope. */
export function addContext(context: LogContext): void {
  const current = store.getStore()
  if (current) Object.assign(current, context)
}

export function currentContext(): LogContext {
  return store.getStore() ?? {}
}

type Level = 'debug' | 'info' | 'warn' | 'error'

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = scrubValue({
    level,
    msg,
    ts: new Date().toISOString(),
    ...currentContext(),
    ...fields,
  })

  const serialised = JSON.stringify(line)
  if (level === 'error') console.error(serialised)
  else if (level === 'warn') console.warn(serialised)
  else console.log(serialised)
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== 'production') emit('debug', msg, fields)
  },
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, error?: unknown, fields?: Record<string, unknown>) =>
    emit('error', msg, {
      ...fields,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error ?? ''),
    }),
}

/**
 * RED metrics on Server Actions — docs/08: rate, errors, duration.
 *
 * Wraps an action so every call logs its outcome and duration with the request context
 * attached. Errors are re-thrown: this measures, it does not swallow.
 */
export async function measured<T>(
  name: string,
  fn: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const started = Date.now()
  try {
    const result = await fn()
    log.info('action', { action: name, ok: true, durationMs: Date.now() - started, ...fields })
    return result
  } catch (error) {
    log.error('action failed', error, { action: name, ok: false, durationMs: Date.now() - started, ...fields })
    throw error
  }
}
