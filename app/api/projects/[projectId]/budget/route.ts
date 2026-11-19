import { api, requireProject, ok, HttpError } from '@/lib/api/context'
import { loadFinancials } from '@/lib/project-financials'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/projects/[projectId]/budget - project managers and org-wide viewers only.
// Budget is read through the caller's session, so the database (project_financials RLS)
// is the final check (G-6).
export const GET = api<{ projectId: string }>(async (_request, ctx, params) => {
  const access = await requireProject(ctx, params.projectId, 'view')
  if (!access.canManage && !ctx.has('view_all_projects')) throw new HttpError(403, 'Budget is visible to project managers only')
  const p = access.project
  const [financials, { data: entries }, { data: settings }] = await Promise.all([
    loadFinancials(ctx.supabase, [p.id]),
    ctx.admin.from('time_entries').select('hours_logged').eq('project_id', p.id),
    ctx.admin.from('app_settings').select('default_hourly_rate, currency').maybeSingle(),
  ])
  const f = financials[p.id] || { budget: null, hourly_rate: null, currency: null }
  const loggedHours = (entries || []).reduce((sum: number, e: any) => sum + Number(e.hours_logged || 0), 0)
  const rate = Number(f.hourly_rate ?? settings?.default_hourly_rate ?? 0)
  const budget = f.budget
  const spent = Math.round(loggedHours * rate * 100) / 100
  const percent = budget && budget > 0 ? Math.round((spent / budget) * 1000) / 10 : null
  return ok({
    budget,
    hourly_rate: rate,
    project_hourly_rate: f.hourly_rate,
    default_hourly_rate: Number(settings?.default_hourly_rate ?? 0),
    // Project currency, else the company currency (ISO code, e.g. INR)
    currency: f.currency || settings?.currency || 'INR',
    project_currency: f.currency,
    company_currency: settings?.currency || 'INR',
    logged_hours: Math.round(loggedHours * 100) / 100,
    estimated_hours: p.estimated_hours != null ? Number(p.estimated_hours) : null,
    spent,
    remaining: budget != null ? Math.round((budget - spent) * 100) / 100 : null,
    percent_used: percent,
    status: percent == null ? 'none' : percent >= 100 ? 'over' : percent >= 80 ? 'warning' : 'ok',
  })
})
