import { z } from 'zod'
import { api, ok, readJson, weekStart, check, HttpError } from '@/lib/api/context'
import { buildWeek } from '@/lib/timesheets'
import { notify } from '@/lib/notify'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/me/timesheets?weekStart=YYYY-MM-DD  (default: current week)
export const GET = api(async (request, ctx) => {
  const ws = weekStart(new URL(request.url).searchParams.get('weekStart') || new Date())
  const [{ data: sheet }, week] = await Promise.all([
    ctx.admin.from('timesheets').select('*').eq('user_id', ctx.userId).eq('week_start_date', ws).maybeSingle(),
    buildWeek(ctx.admin, ctx.userId, ws),
  ])
  let reviewer: string | null = null
  if (sheet?.reviewed_by) {
    const { data } = await ctx.admin.from('user_profiles').select('name').eq('id', sheet.reviewed_by).maybeSingle()
    reviewer = data?.name || null
  }
  return ok({ weekStart: ws, status: sheet?.status || 'draft', timesheet: sheet, reviewer, ...week })
})

// POST /api/me/timesheets { weekStart } - submit the week for approval (locks it)
export const POST = api(async (request, ctx) => {
  const body = await readJson(request, z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}/) }))
  const ws = weekStart(body.weekStart)
  const { data: existing } = await ctx.admin.from('timesheets').select('*').eq('user_id', ctx.userId).eq('week_start_date', ws).maybeSingle()
  if (existing && ['submitted', 'approved'].includes(existing.status)) throw new HttpError(409, `This timesheet is already ${existing.status}`)
  const week = await buildWeek(ctx.admin, ctx.userId, ws)
  if (week.total <= 0) throw new HttpError(400, 'There are no hours logged in this week')

  const row = { user_id: ctx.userId, week_start_date: ws, status: 'submitted', total_hours: week.total, submitted_at: new Date().toISOString(), reviewed_by: null, reviewed_at: null, review_note: null, updated_at: new Date().toISOString() }
  const sheet = existing
    ? check(await ctx.admin.from('timesheets').update(row).eq('id', existing.id).select('*').single())
    : check(await ctx.admin.from('timesheets').insert(row).select('*').single())

  // Notify approvers: users with approve_timesheets who lead a project this person logged time on
  const projectIds = Array.from(new Set(week.entries.map((e: any) => e.project_id)))
  const approverIds = new Set<string>()
  if (projectIds.length) {
    const [{ data: members }, { data: pms }] = await Promise.all([
      ctx.admin.from('project_assignments').select('user_id').in('project_id', projectIds).is('removed_at', null),
      ctx.admin.from('projects').select('assigned_user_id').in('id', projectIds),
    ])
    const candidates = Array.from(new Set([...(members || []).map((m: any) => m.user_id), ...(pms || []).map((p: any) => p.assigned_user_id).filter(Boolean)]))
      .filter((id) => id !== ctx.userId)
    if (candidates.length) {
      const { data: roles } = await ctx.admin.from('user_roles').select('user_id, roles!user_roles_role_id_fkey(permissions)').in('user_id', candidates)
      ;(roles || []).forEach((r: any) => {
        const role = Array.isArray(r.roles) ? r.roles[0] : r.roles
        if (role?.permissions?.approve_timesheets) approverIds.add(r.user_id)
      })
    }
  }
  await notify(ctx.admin, Array.from(approverIds), {
    type: 'timesheet_submitted', title: 'Timesheet submitted',
    message: `${ctx.user?.name || 'An employee'} submitted ${week.total}h for the week of ${ws}`,
    link: '/manager/timesheets',
  }, ctx.userId)
  return ok(sheet, 201)
})
