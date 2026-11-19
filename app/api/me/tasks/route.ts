import { api, ok, today } from '@/lib/api/context'
import { normalizeStatus } from '@/lib/task-rules'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/me/tasks?view=assigned|created|in_progress|review|changes_requested|done|overdue|to_review
//                   &projectId=&priority=&status=&due=today|week|overdue&q=
export const GET = api(async (request, ctx) => {
  const sp = new URL(request.url).searchParams
  const view = sp.get('view') || 'assigned'
  const t = today()

  // Everything relevant to me: assigned to me, created by me, or waiting for my review
  const { data: rows } = await ctx.admin
    .from('tasks')
    .select('id, name, description, status, priority, progress_percent, start_date, due_date, estimated_hours, actual_hours, project_id, parent_task_id, assigned_to, created_by, reviewer_id, review_note, updated_at, projects!tasks_project_id_fkey(id, name, status, archived_at)')
    .or(`assigned_to.eq.${ctx.userId},created_by.eq.${ctx.userId},reviewer_id.eq.${ctx.userId}`)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(1000)

  const all = (rows || []).map((r: any) => ({
    ...r,
    status: normalizeStatus(r.status),
    project: Array.isArray(r.projects) ? r.projects[0] : r.projects,
  })).filter((r: any) => r.project && !r.project.archived_at)

  const assigned = all.filter((r: any) => r.assigned_to === ctx.userId)
  const isOverdue = (r: any) => r.due_date && r.due_date.slice(0, 10) < t && r.status !== 'done'
  const views: Record<string, any[]> = {
    assigned,
    created: all.filter((r: any) => r.created_by === ctx.userId),
    in_progress: assigned.filter((r: any) => r.status === 'in_progress'),
    review: assigned.filter((r: any) => r.status === 'review'),
    changes_requested: assigned.filter((r: any) => r.status === 'changes_requested'),
    done: assigned.filter((r: any) => r.status === 'done'),
    overdue: assigned.filter(isOverdue),
    to_review: all.filter((r: any) => r.reviewer_id === ctx.userId && r.status === 'review' && r.assigned_to !== ctx.userId),
  }

  let list = views[view] || views.assigned
  const projectId = sp.get('projectId')
  const priority = sp.get('priority')
  const status = sp.get('status')
  const due = sp.get('due')
  const q = (sp.get('q') || '').toLowerCase()
  if (projectId) list = list.filter((r: any) => r.project_id === projectId)
  if (priority) list = list.filter((r: any) => r.priority === priority)
  if (status) list = list.filter((r: any) => r.status === status)
  if (q) list = list.filter((r: any) => r.name.toLowerCase().includes(q))
  if (due === 'today') list = list.filter((r: any) => r.due_date?.slice(0, 10) === t)
  if (due === 'overdue') list = list.filter(isOverdue)
  if (due === 'week') {
    const end = new Date(`${t}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 7)
    const endIso = end.toISOString().slice(0, 10)
    list = list.filter((r: any) => r.due_date && r.due_date.slice(0, 10) >= t && r.due_date.slice(0, 10) <= endIso)
  }

  // subtask counts
  const ids = list.map((r: any) => r.id)
  const counts: Record<string, { total: number; done: number }> = {}
  if (ids.length) {
    const { data: subs } = await ctx.admin.from('tasks').select('parent_task_id, status').in('parent_task_id', ids)
    ;(subs || []).forEach((s: any) => {
      const c = counts[s.parent_task_id] || (counts[s.parent_task_id] = { total: 0, done: 0 })
      c.total += 1
      if (s.status === 'done') c.done += 1
    })
  }

  const projects = Array.from(new Map(all.map((r: any) => [r.project.id, { id: r.project.id, name: r.project.name }])).values())
  return ok(
    list.map((r: any) => ({ ...r, projects: undefined, subtasks: counts[r.id] || { total: 0, done: 0 } })),
    200,
    { counts: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.length])), projects }
  )
})
