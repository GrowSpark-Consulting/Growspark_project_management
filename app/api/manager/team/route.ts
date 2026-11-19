import { api, ok, getScope, requireManager, today, weekStart, addDays } from '@/lib/api/context'
import { normalizeStatus } from '@/lib/task-rules'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/manager/team?weekStart= - people working on projects I oversee + workload
export const GET = api(async (request, ctx) => {
  requireManager(ctx)
  const ws = weekStart(new URL(request.url).searchParams.get('weekStart') || new Date())
  const scope = await getScope(ctx)
  const ids = scope.projectIds
  const t = today()
  if (!ids.length) return ok([], 200, { weekStart: ws })

  const [assign, tasksRes, projectsRes] = await Promise.all([
    ctx.admin.from('project_assignments').select('user_id, project_id, role_in_project').in('project_id', ids).is('removed_at', null),
    ctx.admin.from('tasks').select('id, status, due_date, assigned_to, project_id').in('project_id', ids),
    ctx.admin.from('projects').select('id, name').in('id', ids),
  ])
  const projectName: Record<string, string> = Object.fromEntries((projectsRes.data || []).map((p: any) => [p.id, p.name]))
  const userIds = new Set<string>((assign.data || []).map((a: any) => a.user_id))
  ;(tasksRes.data || []).forEach((x: any) => x.assigned_to && userIds.add(x.assigned_to))
  if (!userIds.size) return ok([], 200, { weekStart: ws })
  const list = Array.from(userIds)

  const [profiles, entries, availability, roles] = await Promise.all([
    ctx.admin.from('user_profiles').select('id, name, email, image, phone, is_client, is_active').in('id', list),
    ctx.admin.from('time_entries').select('user_id, hours_logged, project_id').in('user_id', list).gte('entry_date', ws).lte('entry_date', addDays(ws, 6)),
    ctx.admin.from('user_availability').select('user_id, available_hours').in('user_id', list).eq('week_start_date', ws),
    ctx.admin.from('user_roles').select('user_id, roles!user_roles_role_id_fkey(name)').in('user_id', list),
  ])
  const tasks = (tasksRes.data || []).map((x: any) => ({ ...x, status: normalizeStatus(x.status) }))
  const rows = (profiles.data || []).filter((p: any) => !p.is_client).map((p: any) => {
    const mine = tasks.filter((x: any) => x.assigned_to === p.id)
    const open = mine.filter((x: any) => x.status !== 'done')
    const hours = (entries.data || []).filter((e: any) => e.user_id === p.id).reduce((s: number, e: any) => s + Number(e.hours_logged || 0), 0)
    const avail = (availability.data || []).find((a: any) => a.user_id === p.id)
    const available = avail ? Number(avail.available_hours) : 40
    const projects = Array.from(new Set((assign.data || []).filter((a: any) => a.user_id === p.id).map((a: any) => a.project_id as string))) as string[]
    return {
      user: { id: p.id, name: p.name, email: p.email, image: p.image, phone: p.phone, is_active: p.is_active !== false },
      roles: (roles.data || []).filter((r: any) => r.user_id === p.id).map((r: any) => (Array.isArray(r.roles) ? r.roles[0] : r.roles)?.name).filter(Boolean),
      open_tasks: open.length,
      in_progress: open.filter((x: any) => x.status === 'in_progress').length,
      in_review: open.filter((x: any) => x.status === 'review').length,
      overdue_tasks: open.filter((x: any) => x.due_date && x.due_date.slice(0, 10) < t).length,
      done_tasks: mine.length - open.length,
      hours_logged_week: Math.round(hours * 100) / 100,
      available_hours_week: available,
      utilization_percent: available > 0 ? Math.round((hours / available) * 100) : null,
      projects: projects.map((id) => ({ id, name: projectName[id] || '' })),
    }
  }).sort((a: any, b: any) => b.open_tasks - a.open_tasks)
  return ok(rows, 200, { weekStart: ws })
})
