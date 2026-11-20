import { describe, it, expect, afterEach, vi } from 'vitest'
import { r2ConfigFrom, attachmentDisposition, fileStore, StorageConfigError } from '@/lib/file-storage'

const FULL = { R2_ACCOUNT_ID: 'abc123', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'pm-files' }

describe('r2ConfigFrom: which storage the app uses', () => {
  it('no R2 settings → Supabase Storage (null)', () => {
    expect(r2ConfigFrom({})).toBeNull()
  })
  it('all four settings → the account R2 endpoint, region auto', () => {
    expect(r2ConfigFrom(FULL)).toEqual({
      endpoint: 'https://abc123.r2.cloudflarestorage.com', region: 'auto', bucket: 'pm-files', accessKeyId: 'key', secretAccessKey: 'secret',
    })
  })
  it('an explicit endpoint (EU jurisdiction or a test server) replaces the account id; trailing slash dropped', () => {
    const { R2_ACCOUNT_ID: _omit, ...rest } = FULL
    const cfg = r2ConfigFrom({ ...rest, R2_ENDPOINT: 'https://abc123.eu.r2.cloudflarestorage.com/', R2_REGION: 'auto' })
    expect(cfg?.endpoint).toBe('https://abc123.eu.r2.cloudflarestorage.com')
  })
  it('partial settings are an error that names what is missing (never a silent fallback)', () => {
    expect(() => r2ConfigFrom({ R2_BUCKET: 'pm-files' })).toThrow(StorageConfigError)
    expect(() => r2ConfigFrom({ ...FULL, R2_SECRET_ACCESS_KEY: ' ' })).toThrow(/R2_SECRET_ACCESS_KEY/)
  })
})

describe('attachmentDisposition: download file names', () => {
  it('plain names', () => {
    expect(attachmentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`)
  })
  it('quotes and non-ASCII are safe in the plain part and exact in filename*', () => {
    const h = attachmentDisposition('Plan "v2" – ₹.pdf')
    expect(h).toContain('filename="Plan _v2_ _ _.pdf"')
    expect(h).toContain(`filename*=UTF-8''Plan%20%22v2%22%20%E2%80%93%20%E2%82%B9.pdf`)
  })
  it("encodes characters encodeURIComponent leaves alone (' ( ) *)", () => {
    expect(attachmentDisposition("a'(b)*.txt")).toContain(`filename*=UTF-8''a%27%28b%29%2A.txt`)
  })
})

describe('fileStore', () => {
  afterEach(() => { vi.unstubAllEnvs() })
  it('uses R2 when it is configured', () => {
    for (const [k, v] of Object.entries(FULL)) vi.stubEnv(k, v)
    expect(fileStore().backend).toBe('r2')
  })
  it('uses Supabase Storage with the given admin client otherwise', () => {
    for (const k of Object.keys(FULL)) vi.stubEnv(k, '')
    vi.stubEnv('R2_ENDPOINT', '')
    expect(fileStore({ storage: { from: () => ({}) } }).backend).toBe('supabase')
  })
})
