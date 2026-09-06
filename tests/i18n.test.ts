import { describe, expect, it } from 'vitest'
import en from '@/lib/i18n/en.json'
import sv from '@/lib/i18n/sv.json'
import { DEFAULT_LOCALE, isLocale, localeFromAcceptLanguage, LOCALES } from '@/lib/i18n/config'

type Tree = { [key: string]: string | Tree }

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'string' ? [path] : flatten(value, path)
  })
}

function placeholders(tree: Tree, prefix = ''): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      const found = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
      if (found.length > 0) out.set(path, found)
    } else {
      for (const [k, v] of placeholders(value, path)) out.set(k, v)
    }
  }
  return out
}

const svKeys = flatten(sv as Tree)
const enKeys = flatten(en as Tree)

describe('translations — docs/01 acceptance "Both locales complete (test fails on missing key)"', () => {
  it('has the same keys in both languages', () => {
    const missingInEn = svKeys.filter((k) => !enKeys.includes(k))
    const missingInSv = enKeys.filter((k) => !svKeys.includes(k))
    expect(missingInEn, `missing from en.json: ${missingInEn.join(', ')}`).toEqual([])
    expect(missingInSv, `missing from sv.json: ${missingInSv.join(', ')}`).toEqual([])
  })

  it('has no empty strings', () => {
    const check = (tree: Tree, name: string) => {
      for (const path of flatten(tree)) {
        const value = path.split('.').reduce<unknown>((acc, k) => (acc as Tree)[k], tree)
        expect(String(value).trim(), `${name}:${path} is empty`).not.toBe('')
      }
    }
    check(sv as Tree, 'sv')
    check(en as Tree, 'en')
  })

  it('uses the same interpolation placeholders in both languages', () => {
    const svPh = placeholders(sv as Tree)
    const enPh = placeholders(en as Tree)
    for (const [key, vars] of svPh) {
      expect(enPh.get(key) ?? [], `placeholders differ at ${key}`).toEqual(vars)
    }
    for (const [key, vars] of enPh) {
      expect(svPh.get(key) ?? [], `placeholders differ at ${key}`).toEqual(vars)
    }
  })

  it('covers every placement state, so no state can render as a raw enum', () => {
    const states = [
      'CLAIMED', 'UPLOADED', 'POSITIONED', 'GENERATING', 'GENERATION_FAILED',
      'PARTICIPANT_REVIEW', 'BRAND_REVIEW', 'APPROVED', 'PUBLISHED', 'VERIFYING',
      'FLAGGED', 'QUALIFIED', 'PAID', 'REJECTED', 'EXPIRED',
      'REJECTED_BY_PARTICIPANT', 'REJECTED_BY_BRAND', 'DISPUTED',
    ]
    for (const state of states) {
      expect(svKeys, `sv missing placement.states.${state}`).toContain(`placement.states.${state}`)
      expect(enKeys, `en missing placement.states.${state}`).toContain(`placement.states.${state}`)
    }
  })

  it('covers every reject reason', () => {
    const reasons = ['NO_DISCLOSURE', 'MEDIA_MISMATCH', 'WRONG_ACCOUNT', 'DELETED_EARLY', 'FRAUD', 'BRAND_SAFETY', 'OTHER']
    for (const reason of reasons) {
      expect(svKeys).toContain(`placement.rejectReasons.${reason}`)
      expect(enKeys).toContain(`placement.rejectReasons.${reason}`)
    }
  })
})

describe('locale resolution', () => {
  it('defaults to Swedish', () => {
    expect(DEFAULT_LOCALE).toBe('sv')
    expect(localeFromAcceptLanguage(null)).toBe('sv')
    expect(localeFromAcceptLanguage('')).toBe('sv')
    expect(localeFromAcceptLanguage('de-DE,fr;q=0.8')).toBe('sv')
  })

  it('reads Accept-Language including quality values', () => {
    expect(localeFromAcceptLanguage('en-US,en;q=0.9')).toBe('en')
    expect(localeFromAcceptLanguage('sv-SE,sv;q=0.9,en;q=0.8')).toBe('sv')
    expect(localeFromAcceptLanguage('en;q=0.7,sv;q=0.9')).toBe('sv')
    expect(localeFromAcceptLanguage('en;q=0.9,sv;q=0.4')).toBe('en')
  })

  it('validates locale values', () => {
    expect(isLocale('sv')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('no')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
    expect(LOCALES).toEqual(['sv', 'en'])
  })
})
