import { api, ok, getScope, requireManager, today } from '@/lib/api/context'
import { assigneeIdsByTask } from '@/lib/task-assignees'
import { normalizeStatus } from '@/lib/task-rules'
import { loadFinancials } from '@/lib/project-financials'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/manager/overview - manager dashboard (scoped to projects the user oversees)
export const GET = api(async (_request, ctx) => {
  requireManager(ctx)
  const scope = await getScope(ctx)
  const ids = scope.projectIds
  const t = today()
  if (ids.length === 0) {
    return ok({ scope: { all: scope.all, projects: 0 }, counts: { total: 0, active: 0, completed: 0, delayed: 0, archived: 0, onHold: 0 }, employees: 0, tasks: { pending: 0, completed: 0, awaitingReview: 0, overdue: 0 }, workload: [], pendingApprovals: { tasks: 0, timesheets: 0, deliverables: 0 }, clientFeedback: { average: null, count: 0, recent: [] }, projects: [], upcomingDeadlines: [], recentActivity: [], risks: { open: 0, high: 0 } })
  }

  const [projectsRes, tasksRes, assignRes, milestonesRes, feedbackRes, activityRes, deliverablesRes, entriesRes, risksRes] = await Promise.all([
    ctx.admin.from('projects').select('id, name, status, priority, start_date, end_date, estimated_hours, archived_at, account_id, assigned_user_id, accounts!projects_account_id_fkey(name)').in('id', ids),
    ctx.admin.from('tasks').select('id, name, status, due_date, project_id, assigned_to, reviewer_id, parent_task_id').in('project_id', ids),
    ctx.admin.from('project_assignments').select('user_id, project_id').in('project_id', ids).is('removed_at', null),
    ctx.admin.from('milestones').select('id, name, date, status, project_id').in('project_id', ids).eq('status', 'pending').gte('date', t).order('date').limit(10),
    ctx.admin.from('client_feedback').select('id, project_id, satisfaction_score, what_went_well, what_needs_improvement, submitted_at').in('project_id', ids).order('submitted_at', { ascending: false }).limit(20),
    ctx.admin.from('task_activity').select('id, task_id, project_id, action, from_value, to_value, note, actor_id, created_at').in('project_id', ids).order('created_at', { ascending: false }).limit(20),
    ctx.admin.from('deliverables').select('id, status, project_id').in('project_id', ids).eq('status', 'pending_review'),
    ctx.admin.from('time_entries').select('project_id, hours_logged').in('project_id', ids),
    ctx.admin.from('project_issues').select('id, kind, severity, status, project_id').in('project_id', ids).eq('kind', 'risk').neq('status', 'resolved'),
  ])
  const { data: settings } = await ctx.admin.from('app_settings').select('default_hourly_rate, currency').maybeSingle()
  // Budgets the caller may see (project managers / org-wide viewers), enforced by the database (G-6)
  const financials = await loadFinancials(ctx.supabase, ids)

  const projects = projectsRes.data || []
  const tasks = (tasksRes.data || []).map((x: any) => ({ ...x, status: normalizeStatus(x.status) }))
  const hoursByProject: Record<string, number> = {}
  ;(entriesRes.data || []).forEach((e: any) => { hoursByProject[e.project_id] = (hoursByProject[e.project_id] || 0) + Number(e.hours_logged || 0) })

  const projectRows = projects.map((p: any) => {
    const pt = tasks.filter((x: any) => x.project_id === p.id && !x.parent_task_id)
    const done = pt.filter((x: any) => x.status === 'done').length
    const isActive = p.status !== 'complete' && !p.archived_at
    const isDelayed = isActive && !!p.end_date && p.end_date.slice(0, 10) < t
    const logged = Math.round((hoursByProject[p.id] || 0) * 100) / 100
    const fin = financials[p.id]
    const rate = Number(fin?.hourly_rate ?? settings?.default_hourly_rate ?? 0)
    const spent = logged * rate
    const budgetPct = fin?.budget ? Math.round((spent / fin.budget) * 100) : null
    const next = (milestonesRes.data || []).find((m: any) => m.project_id === p.id)
    return {
      id: p.id, name: p.name, status: p.status, priority: p.priority, end_date: p.end_date, archived: !!p.archived_at,
      account: (Array.isArray(p.accounts) ? p.accounts[0] : p.accounts)?.name || '',
      progress_percent: pt.length ? Math.round((done / pt.length) * 100) : 0,
      tasks_total: pt.length, tasks_done: done,
      overdue_tasks: tasks.filter((x: any) => x.project_id === p.id && x.status !== 'done' && x.due_date && x.due_date.slice(0, 10) < t).length,
      estimated_hours: p.estimated_hours != null ? Number(p.estimated_hours) : null,
      logged_hours: logged,
      budget_percent: budgetPct,
      budget_status: budgetPct == null ? 'none' : budgetPct >= 100 ? 'over' : budgetPct >= 80 ? 'warning' : 'ok',
      next_milestone: next ? { name: next.name, date: next.date } : null,
      is_delayed: isDelayed,
    }
  })

  // Workload: open tasks per team member
  const memberIds = new Set<string>((assignRes.data || []).map((a: any) => a.user_id))
  // Everyone on each task (shared tasks have several assignees)
  const onTask = await assigneeIdsByTask(ctx.admin, tasks.map((x: any) => x.id))
  const peopleOn = (x: any): string[] => onTask.get(x.id) || (x.assigned_to ? [x.assigned_to] : [])
  tasks.forEach((x: any) => peopleOn(x).forEach((id) => memberIds.add(id)))
  const { data: people } = memberIds.size
    ? await ctx.admin.from('user_profiles').select('id, name, is_client, is_active').in('id', Array.from(memberIds))
    : { data: [] }
  const staff = (people || []).filter((p: any) => !p.is_client && p.is_active !== false)
  const workload = staff.map((p: any) => {
    const mine = tasks.filter((x: any) => peopleOn(x).includes(p.id) && x.status !== 'done')
    return { user: { id: p.id, name: p.name }, open: mine.length, overdue: mine.filter((x: any) => x.due_date && x.due_date.slice(0, 10) < t).length, inReview: mine.filter((x: any) => x.status === 'review').length }
  }).sort((a: any, b: any) => b.open - a.open)

  // Pending approvals visible to me
  const reviewTasks = tasks.filter((x: any) => x.status === 'review' && (x.reviewer_id === ctx.userId || !x.reviewer_id))
  let pendingTimesheets = 0
  if (ctx.has('approve_timesheets') || ctx.has('view_all_time_entries')) {
    const { data: sheets } = await ctx.admin.from('timesheets').select('user_id').eq('status', 'submitted')
    pendingTimesheets = (sheets || []).filter((s: any) => s.user_id !== ctx.userId && (scope.all || memberIds.has(s.user_id))).length
  }

  const feedback = feedbackRes.data || []
  const scored = feedback.filter((f: any) => f.satisfaction_score != null)
  const names: Record<string, string> = Object.fromEntries(projects.map((p: any) => [p.id, p.name]))
  const actorIds = Array.from(new Set((activityRes.data || []).map((a: any) => a.actor_id).filter(Boolean))) as string[]
  const { data: actors } = actorIds.length ? await ctx.admin.from('user_profiles').select('id, name').in('id', actorIds) : { data: [] }
  const actorNames: Record<string, string> = Object.fromEntries((actors || []).map((a: any) => [a.id, a.name]))
  const taskNames: Record<string, string> = Object.fromEntries(tasks.map((x: any) => [x.id, x.name]))

  const active = projectRows.filter((p: any) => p.status !== 'complete' && !p.archived)
  return ok({
    scope: { all: scope.all, projects: ids.length },
    counts: {
      total: projectRows.filter((p: any) => !p.archived).length,
      active: active.length,
      completed: projectRows.filter((p: any) => p.status === 'complete').length,
      delayed: projectRows.filter((p: any) => p.is_delayed).length,
      onHold: projectRows.filter((p: any) => p.status === 'on_hold').length,
      archived: projectRows.filter((p: any) => p.archived).length,
      overBudget: projectRows.filter((p: any) => p.budget_status === 'over').length,
    },
    employees: staff.length,
    tasks: {
      pending: tasks.filter((x: any) => x.status !== 'done').length,
      completed: tasks.filter((x: any) => x.status === 'done').length,
      awaitingReview: tasks.filter((x: any) => x.status === 'review').length,
      overdue: tasks.filter((x: any) => x.status !== 'done' && x.due_date && x.due_date.slice(0, 10) < t).length,
    },
    workload,
    pendingApprovals: { tasks: reviewTasks.length, timesheets: pendingTimesheets, deliverables: (deliverablesRes.data || []).length },
    clientFeedback: {
      count: feedback.length,
      average: scored.length ? Math.round((scored.reduce((s: number, f: any) => s + f.satisfaction_score, 0) / scored.length) * 10) / 10 : null,
      recent: feedback.slice(0, 5).map((f: any) => ({ ...f, project_name: names[f.project_id] })),
    },
    risks: { open: (risksRes.data || []).length, high: (risksRes.data || []).filter((r: any) => ['high', 'critical'].includes(r.severity)).length },
    projects: projectRows.filter((p: any) => !p.archived).sort((a: any, b: any) => Number(b.is_delayed) - Number(a.is_delayed) || (a.end_date || '9').localeCompare(b.end_date || '9')),
    upcomingDeadlines: [
      ...(milestonesRes.data || []).map((m: any) => ({ type: 'milestone', id: m.id, name: m.name, date: m.date, project_id: m.project_id, project_name: names[m.project_id] })),
      ...tasks.filter((x: any) => x.status !== 'done' && x.due_date && x.due_date.slice(0, 10) >= t).map((x: any) => ({ type: 'task', id: x.id, name: x.name, date: x.due_date, project_id: x.project_id, project_name: names[x.project_id] })),
    ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10),
    recentActivity: (activityRes.data || []).map((a: any) => ({
      ...a, actor_name: actorNames[a.actor_id] || 'System', task_name: taskNames[a.task_id] || 'Task', project_name: names[a.project_id] || '',
    })),
  })
})
