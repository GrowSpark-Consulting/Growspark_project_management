/**
 * Cloudflare R2 file storage against a LOCAL S3-compatible server (R2 speaks the S3 API).
 * Skipped unless R2_TEST_ENDPOINT points at localhost, for example:
 *
 *   docker run -d --name pm-r2-test -p 127.0.0.1:9100:9000 \
 *     -e RUSTFS_ACCESS_KEY=pmtestaccess -e RUSTFS_SECRET_KEY=pmtestsecret123 rustfs/rustfs:latest
 *   R2_TEST_ENDPOINT=http://127.0.0.1:9100 R2_TEST_ACCESS_KEY_ID=pmtestaccess \
 *     R2_TEST_SECRET_ACCESS_KEY=pmtestsecret123 npx vitest run __tests__/integration/r2-storage.test.ts
 *
 * A temporary bucket is created and removed. Covers the adapter (put, get, exists, signed links,
 * expiry, tampering, private bucket, delete) and lib/files.ts (upload, download redirect, delete,
 * clean-up when the database insert fails) with the R2 backend switched on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { r2Store, fileStore, type R2Config } from '@/lib/file-storage'
import { storeProjectFile, signedDownload, deleteProjectFile } from '@/lib/files'

const endpoint = process.env.R2_TEST_ENDPOINT
const local = !!endpoint && ['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname)
const cfg: R2Config = {
  endpoint: endpoint || '',
  region: process.env.R2_TEST_REGION || 'us-east-1',
  bucket: `pm-r2-test-${Date.now().toString(36)}`,
  accessKeyId: process.env.R2_TEST_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_TEST_SECRET_ACCESS_KEY || '',
}
const raw = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } })
const bytes = (s: string) => Buffer.from(s, 'utf8')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Minimal stand-in for the Supabase admin client: only project_files insert and delete. */
function fakeAdmin(opts: { insertError?: Error } = {}) {
  const rows: Record<string, unknown>[] = []
  return {
    rows,
    from: () => ({
      insert: (row: Record<string, unknown>) => ({
        select: () => ({ single: async () => (opts.insertError ? { data: null, error: opts.insertError } : (rows.push(row), { data: row, error: null })) }),
      }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }
}

describe.skipIf(!local)('Cloudflare R2 storage (local S3-compatible server)', () => {
  const store = r2Store(cfg)

  beforeAll(async () => {
    await raw.send(new CreateBucketCommand({ Bucket: cfg.bucket }))
    vi.stubEnv('R2_ENDPOINT', cfg.endpoint)
    vi.stubEnv('R2_REGION', cfg.region)
    vi.stubEnv('R2_BUCKET', cfg.bucket)
    vi.stubEnv('R2_ACCESS_KEY_ID', cfg.accessKeyId)
    vi.stubEnv('R2_SECRET_ACCESS_KEY', cfg.secretAccessKey)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    const list = await raw.send(new ListObjectsV2Command({ Bucket: cfg.bucket })).catch(() => null)
    for (const o of list?.Contents || []) await raw.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: o.Key! }))
    await raw.send(new DeleteBucketCommand({ Bucket: cfg.bucket })).catch(() => undefined)
  })

  it('stores and reads back an object; exists() reflects it', async () => {
    await store.put('p1/f1/notes.txt', bytes('hello R2'), 'text/plain')
    expect(await store.exists('p1/f1/notes.txt')).toBe(true)
    expect((await store.get('p1/f1/notes.txt'))?.toString()).toBe('hello R2')
  })

  it('missing objects: get → null, exists → false, remove → no error', async () => {
    expect(await store.get('nope/missing.txt')).toBeNull()
    expect(await store.exists('nope/missing.txt')).toBe(false)
    await expect(store.remove(['nope/missing.txt'])).resolves.toBeUndefined()
  })

  it('the bucket is private: an unsigned link is refused', async () => {
    const res = await fetch(`${cfg.endpoint}/${cfg.bucket}/p1/f1/notes.txt`)
    expect(res.status).toBe(403)
  })

  it('a signed link downloads the file as an attachment with its name', async () => {
    await store.put('p1/f2/Plan v2 ₹.pdf', bytes('%PDF-1.4 test'), 'application/pdf')
    const url = await store.signedDownloadUrl('p1/f2/Plan v2 ₹.pdf', 'Plan v2 ₹.pdf', 60)
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('%PDF-1.4 test')
    expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''Plan%20v2%20%E2%82%B9.pdf`)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('a signed link stops working when it expires', async () => {
    const url = await store.signedDownloadUrl('p1/f1/notes.txt', 'notes.txt', 1)
    await sleep(2500)
    expect((await fetch(url)).status).toBe(403)
  })

  it('a signed link cannot be reused for another file', async () => {
    const url = await store.signedDownloadUrl('p1/f1/notes.txt', 'notes.txt', 60)
    const tampered = url.replace('/p1/f1/notes.txt', '/p1/f2/Plan%20v2%20%E2%82%B9.pdf')
    expect((await fetch(tampered)).status).toBe(403)
  })

  it('remove deletes objects', async () => {
    await store.put('p1/f3/a.txt', bytes('a'), 'text/plain')
    await store.put('p1/f3/b.txt', bytes('b'), 'text/plain')
    await store.remove(['p1/f3/a.txt', 'p1/f3/b.txt'])
    expect(await store.exists('p1/f3/a.txt')).toBe(false)
    expect(await store.exists('p1/f3/b.txt')).toBe(false)
  })

  it('lib/files with R2 switched on: upload → record, download → 60-second signed redirect, delete', async () => {
    expect(fileStore().backend).toBe('r2')
    const admin = fakeAdmin()
    const file = new File([bytes('quarterly numbers')], 'Q3 report.csv', { type: 'text/csv' })
    const row = await storeProjectFile(admin, { projectId: 'proj-1', file, uploadedBy: 'user-1' }) as { storage_path: string; file_name: string; id: string; size_bytes: number }
    expect(row.storage_path).toMatch(/^proj-1\/[0-9a-f-]{36}\/Q3 report\.csv$/)
    expect(row.size_bytes).toBe(17)
    expect(await store.exists(row.storage_path)).toBe(true)

    const redirect = await signedDownload(admin, row)
    expect(redirect.status).toBe(302)
    const link = redirect.headers.get('location')!
    expect(link).toContain('X-Amz-Expires=60')
    const res = await fetch(link)
    expect(await res.text()).toBe('quarterly numbers')

    await deleteProjectFile(admin, row)
    expect(await store.exists(row.storage_path)).toBe(false)
  })

  it('lib/files removes the uploaded object when the database insert fails', async () => {
    const admin = fakeAdmin({ insertError: new Error('insert refused') })
    const file = new File([bytes('x')], 'orphan.txt', { type: 'text/plain' })
    await expect(storeProjectFile(admin, { projectId: 'proj-2', file, uploadedBy: 'user-1' })).rejects.toThrow('insert refused')
    const list = await raw.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: 'proj-2/' }))
    expect(list.KeyCount ?? 0).toBe(0)
  })
})
