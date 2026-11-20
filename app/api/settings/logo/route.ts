import { NextResponse } from 'next/server'
import { api, ok, check, HttpError } from '@/lib/api/context'

/* eslint-disable @typescript-eslint/no-explicit-any */
const BUCKET = 'project-files'
const MAX_BYTES = 1024 * 1024 // 1 MB
// No SVG: an SVG served from this domain can carry script
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

// GET /api/settings/logo - the company logo (any signed-in user, including clients)
export const GET = api(async (_request, ctx) => {
  const { data: settings } = await ctx.admin.from('app_settings').select('logo_path').maybeSingle()
  if (!settings?.logo_path) throw new HttpError(404, 'No logo')
  const { data, error } = await ctx.admin.storage.from(BUCKET).download(settings.logo_path)
  if (error || !data) throw new HttpError(404, 'No logo')
  const ext = settings.logo_path.split('.').pop()?.toLowerCase() || ''
  return new NextResponse(Buffer.from(await data.arrayBuffer()), {
    headers: {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, max-age=300',
    },
  })
}, 'any')

// POST /api/settings/logo (multipart "file") - superadmin only
export const POST = api(async (request, ctx) => {
  if (!ctx.isSuperadmin) throw new HttpError(403, 'Only a superadmin can change the company logo')
  let form: FormData
  try { form = await request.formData() } catch { throw new HttpError(400, 'Expected multipart/form-data with a "file" field') }
  const file = form.get('file')
  if (!file || typeof file === 'string') throw new HttpError(400, 'No file uploaded')
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!TYPES[ext]) throw new HttpError(415, 'Logo must be a PNG, JPG or WebP image')
  if (file.size <= 0) throw new HttpError(400, 'File is empty')
  if (file.size > MAX_BYTES) throw new HttpError(413, 'Logo must be 1 MB or smaller')
  const bytes = Buffer.from(await file.arrayBuffer())
  // Check the real content, not just the name
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8
  const isWebp = bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  const okType = ext === 'png' ? isPng : ext === 'webp' ? isWebp : isJpg
  if (!okType) throw new HttpError(415, 'The file is not a valid image of that type')

  const { data: current } = await ctx.admin.from('app_settings').select('logo_path').maybeSingle()
  const path = `branding/logo-${Date.now()}.${ext}`
  const { error: upErr } = await ctx.admin.storage.from(BUCKET).upload(path, bytes, { contentType: TYPES[ext], upsert: false })
  if (upErr) throw new HttpError(500, `Upload failed: ${upErr.message}`)
  const row = check(await ctx.admin.from('app_settings')
    .upsert({ id: true, logo_path: path, updated_by: ctx.userId, updated_at: new Date().toISOString() }).select('company_name, logo_path, updated_at').single())
  if (current?.logo_path) await ctx.admin.storage.from(BUCKET).remove([current.logo_path])
  return ok(row, 201)
})

// DELETE /api/settings/logo - superadmin only
export const DELETE = api(async (_request, ctx) => {
  if (!ctx.isSuperadmin) throw new HttpError(403, 'Only a superadmin can change the company logo')
  const { data: current } = await ctx.admin.from('app_settings').select('logo_path').maybeSingle()
  if (current?.logo_path) {
    await ctx.admin.storage.from(BUCKET).remove([current.logo_path])
    check(await ctx.admin.from('app_settings').update({ logo_path: null, updated_by: ctx.userId, updated_at: new Date().toISOString() }).eq('id', true))
  }
  return ok({ removed: !!current?.logo_path })
})
