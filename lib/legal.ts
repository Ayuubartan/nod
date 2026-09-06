import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locale } from './i18n/config'

/**
 * Legal drafts live as Markdown in `legal/` so a lawyer can review and edit them
 * without touching TSX (docs/07 section 7).
 */
export type LegalDoc = 'privacy' | 'terms'

export async function readLegal(doc: LegalDoc, locale: Locale): Promise<string> {
  const path = join(process.cwd(), 'legal', `${doc}.${locale}.md`)
  return readFile(path, 'utf8')
}
