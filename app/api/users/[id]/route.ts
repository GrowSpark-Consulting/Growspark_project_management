import { api, ok, HttpError, assertUuid, getScope, today, weekStart, addDays } from '@/lib/api/context'
import { normalizeStatus } from '@/lib/task-rules'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/users/[id] - employee details (self, user managers, or managers sharing a project)
export const GET = api<{ id: string }>(async (_request, ctx, params) => {
  const id = assertUuid(params.id, 'user ID')
  const self = id === ctx.userId
  let visibleProjectIds: string[] | null = null // null = all
  if (!self && !ctx.isSuperadmin && !ctx.has('manage_users') && !ctx.has('manage_user_roles')) {
    const scope = await getScope(ctx)
    if (!scope.all) {
      const { data } = await ctx.admin.from('project_assignments').select('project_id').eq('user_id', id).in('project_id', scope.projectIds.length ? scope.projectIds : ['00000000-0000-0000-0000-000000000000']).is('removed_at', null)
      const shared: string[] = (data || []).map((r: any) => r.project_id as string)
      if (!shared.length) throw new HttpError(404, 'User not found')
      visibleProjectIds = shared
    }
  }
  const { data: profile } = await ctx.admin.from('user_profiles')
    .select('id, name, email, image, bio, skills, phone, is_active, is_client, client_account_id, deactivated_at, created_at').eq('id', id).maybeSingle()
  if (!profile) throw new HttpError(404, 'User not found')

  const ws = weekStart()
  let assignQuery = ctx.admin.from('project_assignments').select('project_id, role_in_project, projects!project_assignments_project_id_fkey(id, name, status, archived_at)').eq('user_id', id).is('removed_at', null)
  if (visibleProjectIds) assignQuery = assignQuery.in('project_id', visibleProjectIds)
  let taskQuery = ctx.admin.from('tasks').select('id, name, status, priority, due_date, project_id').eq('assigned_to', id)
  if (visibleProjectIds) taskQuery = taskQuery.in('project_id', visibleProjectIds)
  let entryQuery = ctx.admin.from('time_entries').select('hours_logged').eq('user_id', id).gte('entry_date', ws).lte('entry_date', addDays(ws, 6))
  if (visibleProjectIds) entryQuery = entryQuery.in('project_id', visibleProjectIds)

  const [roles, assignments, tasks, entries, availability, auth] = await Promise.all([
    ctx.admin.from('user_roles').select('roles!user_roles_role_id_fkey(id, name, departments!roles_department_id_fkey(name))').eq('user_id', id),
    assignQuery, taskQuery, entryQuery,
    ctx.admin.from('user_availability').select('available_hours').eq('user_id', id).eq('week_start_date', ws).maybeSingle(),
    ctx.admin.auth.admin.getUserById(id),
  ])
  const t = today()
  const list = (tasks.data || []).map((x: any) => ({ ...x, status: normalizeStatus(x.status) }))
  return ok({
    profile: { ...profile, last_sign_in_at: auth?.data?.user?.last_sign_in_at || null },
    roles: (roles.data || []).map((r: any) => {
      const role = Array.isArray(r.roles) ? r.roles[0] : r.roles
      const dept = Array.isArray(role?.departments) ? role.departments[0] : role?.departments
      return { id: role?.id, name: role?.name, department: dept?.name || null }
    }),
    projects: (assignments.data || []).map((a: any) => ({ ...(Array.isArray(a.projects) ? a.projects[0] : a.projects), role_in_project: a.role_in_project })).filter((p: any) => p?.id),
    openTasks: list.filter((x: any) => x.status !== 'done').slice(0, 50),
    stats: {
      open: list.filter((x: any) => x.status !== 'done').length,
      overdue: list.filter((x: any) => x.status !== 'done' && x.due_date && x.due_date.slice(0, 10) < t).length,
      done: list.filter((x: any) => x.status === 'done').length,
      hoursThisWeek: Math.round((entries.data || []).reduce((s: number, e: any) => s + Number(e.hours_logged || 0), 0) * 100) / 100,
      availableThisWeek: availability.data ? Number(availability.data.available_hours) : 40,
    },
  })
})
