import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locale } from './i18n/config'

/**
 * Legal drafts live as Markdown in `legal/` so a lawyer can review and edit them
 * without touching TSX (docs/07 section 7).
 */
export type LegalDoc = 'privacy' | 'terms' | 'cookies'

/** Documents that exist in one language only — the brand side operates in English. */
export type SingleLocaleDoc = 'brand-agreement' | 'training-consent'

export async function readLegal(doc: LegalDoc, locale: Locale): Promise<string> {
  const path = join(process.cwd(), 'legal', `${doc}.${locale}.md`)
  return readFile(path, 'utf8')
}

export async function readSingleLocaleLegal(doc: SingleLocaleDoc): Promise<string> {
  const suffix = doc === 'brand-agreement' ? '.en' : ''
  return readFile(join(process.cwd(), 'legal', `${doc}${suffix}.md`), 'utf8')
}
