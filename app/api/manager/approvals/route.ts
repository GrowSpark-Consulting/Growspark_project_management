import { api, ok, getScope, requireManager } from '@/lib/api/context'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/manager/approvals - unified inbox
export const GET = api(async (_request, ctx) => {
  requireManager(ctx)
  const scope = await getScope(ctx)
  const ids = scope.projectIds
  const empty = { tasks: [], timesheets: [], deliverables: [], workflowSteps: [], clientDecisions: [] }
  if (!ids.length) return ok(empty)

  const since = new Date(Date.now() - 14 * 86400000).toISOString()
  const [projects, reviewTasks, deliverables, sheets, decisions, members] = await Promise.all([
    ctx.admin.from('projects').select('id, name, assigned_user_id, created_by').in('id', ids),
    ctx.admin.from('tasks').select('id, name, project_id, assigned_to, reviewer_id, review_note, updated_at, due_date').in('project_id', ids).eq('status', 'review'),
    ctx.admin.from('deliverables').select('id, name, project_id, submitted_by, submitted_at, version, file_url, file_id').in('project_id', ids).eq('status', 'pending_review'),
    ctx.admin.from('timesheets').select('*').eq('status', 'submitted'),
    ctx.admin.from('deliverables').select('id, name, project_id, status, feedback, approved_at, approved_by').in('project_id', ids).in('status', ['approved', 'rejected']).gte('approved_at', since).order('approved_at', { ascending: false }),
    ctx.admin.from('project_assignments').select('user_id, project_id').in('project_id', ids).is('removed_at', null),
  ])
  const pName: Record<string, string> = Object.fromEntries((projects.data || []).map((p: any) => [p.id, p.name]))

  // Which projects can I manage (for task review without a named reviewer)?
  const manageAll = ctx.isSuperadmin || ctx.has('manage_all_projects')
  const myProjects = new Set<string>((members.data || []).filter((m: any) => m.user_id === ctx.userId).map((m: any) => m.project_id))
  ;(projects.data || []).forEach((p: any) => { if (p.assigned_user_id === ctx.userId || p.created_by === ctx.userId) myProjects.add(p.id) })
  const canManage = (pid: string) => manageAll || (ctx.has('manage_projects') && myProjects.has(pid))

  const tasks = (reviewTasks.data || []).filter((x: any) =>
    x.assigned_to !== ctx.userId && (x.reviewer_id === ctx.userId || canManage(x.project_id)))
  const memberIds = new Set<string>((members.data || []).map((m: any) => m.user_id))
  const timesheetRows = (ctx.isSuperadmin || ctx.has('view_all_time_entries') || ctx.has('approve_timesheets'))
    ? (sheets.data || []).filter((s: any) => s.user_id !== ctx.userId && (scope.all || memberIds.has(s.user_id)))
    : []

  const people = new Set<string>()
  tasks.forEach((x: any) => x.assigned_to && people.add(x.assigned_to))
  ;(deliverables.data || []).forEach((d: any) => d.submitted_by && people.add(d.submitted_by))
  timesheetRows.forEach((s: any) => people.add(s.user_id))
  ;(decisions.data || []).forEach((d: any) => d.approved_by && people.add(d.approved_by))
  const { data: profiles } = people.size ? await ctx.admin.from('user_profiles').select('id, name').in('id', Array.from(people)) : { data: [] }
  const nm: Record<string, string> = Object.fromEntries((profiles || []).map((p: any) => [p.id, p.name]))

  // Workflow steps waiting on me (reuse the existing workflow service query)
  let workflowSteps: any[] = []
  try {
    const { getUserPendingApprovals } = await import('@/lib/workflow-execution-service')
    workflowSteps = await getUserPendingApprovals(ctx.supabase, ctx.userId)
  } catch { workflowSteps = [] }

  return ok({
    tasks: tasks.map((x: any) => ({ ...x, project_name: pName[x.project_id], assignee_name: nm[x.assigned_to] || 'Unassigned' })),
    deliverables: (deliverables.data || []).map((d: any) => ({ ...d, project_name: pName[d.project_id], submitted_by_name: nm[d.submitted_by] || '' })),
    timesheets: timesheetRows.map((s: any) => ({ ...s, user_name: nm[s.user_id] || '' })),
    workflowSteps,
    clientDecisions: (decisions.data || []).map((d: any) => ({ ...d, project_name: pName[d.project_id], client_name: nm[d.approved_by] || 'Client' })),
  })
})
