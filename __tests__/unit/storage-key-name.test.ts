import { describe, it, expect } from 'vitest'
import { storageKeyName } from '@/lib/files'

// Supabase Storage accepts only these characters in object keys
const SUPABASE_KEY_OK = /^[A-Za-z0-9 _.()\-!*'&$@=;:+,?]+$/

describe('storageKeyName: object-key form of an uploaded file name', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['Report ₹.csv', 'Report.csv'],
    ['Résumé (final).docx', 'Resume (final).docx'],
    ['Invoice #12 [Q3].pdf', 'Invoice _12 _Q3.pdf'],
    ['फ़ाइल.pdf', 'file.pdf'],
    ['..hidden', 'file.hidden'],
    ['no-extension', 'no-extension'],
  ])('%s → %s', (input, expected) => {
    expect(storageKeyName(input)).toBe(expected)
  })
  it('always produces a key Supabase Storage accepts', () => {
    for (const n of ['Plan v2 – ₹.pdf', '漢字.png', '%%%.txt', 'a'.repeat(300) + '.zip', '.env', 'x.ext€ra']) {
      const k = storageKeyName(n)
      expect(k).toMatch(SUPABASE_KEY_OK)
      expect(k.length).toBeLessThanOrEqual(131)
    }
  })
})
