import { api, ok, getScope, requireManager, weekStart, addDays, HttpError } from '@/lib/api/context'
import { buildWeek } from '@/lib/timesheets'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/manager/timesheets?weekStart=&status=submitted|approved|rejected|draft|all
// Weekly timesheets of people who work on projects I oversee (hours on those projects).
export const GET = api(async (request, ctx) => {
  requireManager(ctx)
  const sp = new URL(request.url).searchParams
  const ws = weekStart(sp.get('weekStart') || new Date())
  const statusFilter = sp.get('status') || 'all'
  const orgWide = ctx.isSuperadmin || ctx.has('view_all_time_entries')
  const scope = await getScope(ctx)
  if (!scope.projectIds.length && !orgWide) return ok([], 200, { weekStart: ws })

  // People with time this week on scoped projects (or anyone, for org-wide approvers)
  let entryQuery = ctx.admin.from('time_entries').select('user_id').gte('entry_date', ws).lte('entry_date', addDays(ws, 6))
  if (!orgWide) entryQuery = entryQuery.in('project_id', scope.projectIds)
  const [{ data: entryUsers }, { data: sheets }] = await Promise.all([
    entryQuery,
    ctx.admin.from('timesheets').select('*').eq('week_start_date', ws),
  ])
  const userIds = new Set<string>((entryUsers || []).map((e: any) => e.user_id))
  ;(sheets || []).forEach((s: any) => {
    if (orgWide || userIds.has(s.user_id)) userIds.add(s.user_id)
  })
  if (!userIds.size) return ok([], 200, { weekStart: ws })

  const { data: people } = await ctx.admin.from('user_profiles').select('id, name, image, is_client').in('id', Array.from(userIds))
  const canApprove = ctx.isSuperadmin || ctx.has('approve_timesheets') || ctx.has('view_all_time_entries')
  const rows = []
  for (const p of (people || []).filter((x: any) => !x.is_client)) {
    const sheet = (sheets || []).find((s: any) => s.user_id === p.id) || null
    const status = sheet?.status || 'draft'
    if (statusFilter !== 'all' && status !== statusFilter) continue
    const week = await buildWeek(ctx.admin, p.id, ws, orgWide ? null : scope.projectIds)
    rows.push({
      user: { id: p.id, name: p.name, image: p.image },
      timesheet: sheet, status,
      can_review: canApprove && p.id !== ctx.userId && status === 'submitted',
      ...week,
    })
  }
  if (statusFilter !== 'all' && !['submitted', 'approved', 'rejected', 'draft'].includes(statusFilter)) throw new HttpError(400, 'Invalid status')
  return ok(rows.sort((a: any, b: any) => (a.status === 'submitted' ? -1 : 1) - (b.status === 'submitted' ? -1 : 1)), 200, { weekStart: ws })
})
