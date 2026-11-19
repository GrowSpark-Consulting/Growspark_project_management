import { api, ok, today, weekStart, addDays } from '@/lib/api/context'
import { normalizeStatus } from '@/lib/task-rules'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/me/summary - employee dashboard numbers
export const GET = api(async (_request, ctx) => {
  const t = today()
  const ws = weekStart()
  const [tasks, entries, notifications, timesheet, assignments] = await Promise.all([
    ctx.admin.from('tasks').select('id, name, status, due_date, project_id, updated_at, completed_at').eq('assigned_to', ctx.userId),
    ctx.admin.from('time_entries').select('hours_logged, entry_date').eq('user_id', ctx.userId).gte('entry_date', ws).lte('entry_date', addDays(ws, 6)),
    ctx.admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId).eq('read', false),
    ctx.admin.from('timesheets').select('status, review_note').eq('user_id', ctx.userId).eq('week_start_date', addDays(ws, -7)).maybeSingle(),
    ctx.admin.from('project_assignments').select('project_id').eq('user_id', ctx.userId).is('removed_at', null),
  ])
  const list = (tasks.data || []).map((x: any) => ({ ...x, status: normalizeStatus(x.status) }))
  const open = list.filter((x: any) => x.status !== 'done')
  const projectIds = new Set<string>([...(assignments.data || []).map((a: any) => a.project_id), ...list.map((x: any) => x.project_id)])
  let activeProjects = 0
  if (projectIds.size) {
    const { count } = await ctx.admin.from('projects').select('id', { count: 'exact', head: true })
      .in('id', Array.from(projectIds)).neq('status', 'complete').is('archived_at', null)
    activeProjects = count || 0
  }
  const { data: nextMilestones } = projectIds.size
    ? await ctx.admin.from('milestones').select('id, name, date, project_id').in('project_id', Array.from(projectIds)).eq('status', 'pending').gte('date', t).order('date').limit(5)
    : { data: [] }

  return ok({
    activeProjects,
    assigned: list.length,
    pending: open.length,
    inProgress: list.filter((x: any) => x.status === 'in_progress').length,
    awaitingReview: list.filter((x: any) => x.status === 'review').length,
    changesRequested: list.filter((x: any) => x.status === 'changes_requested').length,
    completedThisWeek: list.filter((x: any) => x.status === 'done' && (x.completed_at || x.updated_at || '').slice(0, 10) >= ws).length,
    dueToday: open.filter((x: any) => x.due_date?.slice(0, 10) === t),
    overdue: open.filter((x: any) => x.due_date && x.due_date.slice(0, 10) < t),
    hoursThisWeek: Math.round((entries.data || []).reduce((s: number, e: any) => s + Number(e.hours_logged || 0), 0) * 100) / 100,
    unreadNotifications: notifications.count || 0,
    lastWeekTimesheet: timesheet.data || null,
    nextMilestones: nextMilestones || [],
  })
})
