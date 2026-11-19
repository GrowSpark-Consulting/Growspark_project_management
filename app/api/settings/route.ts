import { z } from 'zod'
import { api, ok, readJson, check, HttpError } from '@/lib/api/context'

// GET /api/settings - company settings (all signed-in users, including clients)
export const GET = api(async (_request, ctx) => {
  const { data } = await ctx.admin.from('app_settings').select('company_name, logo_path, timezone, currency, default_hourly_rate, week_starts_on, updated_at').maybeSingle()
  return ok(data || { company_name: 'My Company', timezone: 'Asia/Kolkata', currency: 'INR', default_hourly_rate: 0, week_starts_on: 1 })
}, 'any')

// PATCH /api/settings - superadmin only
export const PATCH = api(async (request, ctx) => {
  if (!ctx.isSuperadmin) throw new HttpError(403, 'Only a superadmin can change company settings')
  const body = await readJson(request, z.object({
    company_name: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().max(64).optional(),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code such as INR').optional(),
    default_hourly_rate: z.number().min(0).max(999999999999.99).optional(),
  }))
  const row = check(await ctx.admin.from('app_settings').upsert({ id: true, ...body, updated_by: ctx.userId, updated_at: new Date().toISOString() }).select('*').single())
  return ok(row)
})
