import { z } from 'zod'
import { api, ok, readJson, check, HttpError } from '@/lib/api/context'
import { slugProblem, normalizePhone } from '@/lib/registration-rules'
import { updateOnboarding } from '@/lib/onboarding-checklist'

// GET /api/settings - company settings (all signed-in users, including clients)
export const GET = api(async (_request, ctx) => {
  const { data } = await ctx.admin.from('app_settings').select('company_name, workspace_name, workspace_slug, company_phone, logo_path, timezone, currency, default_hourly_rate, week_starts_on, registered_at, updated_at').maybeSingle()
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
    workspace_name: z.string().trim().min(2).max(80).optional(),
    workspace_slug: z.string().trim().toLowerCase().superRefine((s, issue) => {
      const problem = slugProblem(s)
      if (problem) issue.addIssue({ code: 'custom', message: problem })
    }).optional(),
    company_phone: z.string().trim().refine((p) => !!normalizePhone(p), 'Enter a valid phone number').transform((p) => normalizePhone(p)!).optional().or(z.literal('').transform(() => null)),
  }))
  const row = check(await ctx.admin.from('app_settings').upsert({ id: true, ...body, updated_by: ctx.userId, updated_at: new Date().toISOString() }).select('*').single())
  if (body.timezone !== undefined || body.currency !== undefined || body.default_hourly_rate !== undefined) {
    await updateOnboarding(ctx.admin, (st) => { st.settingsSaved = true })
  }
  return ok(row)
})
