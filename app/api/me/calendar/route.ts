import { api, ok, HttpError } from '@/lib/api/context'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/me/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
// My task deadlines, deadlines of my projects, milestones of my projects, my availability
export const GET = api(async (request, ctx) => {
  const sp = new URL(request.url).searchParams
  const from = (sp.get('from') || '').slice(0, 10)
  const to = (sp.get('to') || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new HttpError(400, 'from and to (YYYY-MM-DD) are required')
  if ((new Date(to).getTime() - new Date(from).getTime()) / 86400000 > 62) throw new HttpError(400, 'Range is limited to 62 days')

  // My projects (team member, creator, PM, or with tasks assigned)
  const [assigned, owned, mine] = await Promise.all([
    ctx.admin.from('project_assignments').select('project_id').eq('user_id', ctx.userId).is('removed_at', null),
    ctx.admin.from('projects').select('id').or(`created_by.eq.${ctx.userId},assigned_user_id.eq.${ctx.userId}`),
    ctx.admin.from('tasks').select('project_id').eq('assigned_to', ctx.userId),
  ])
  const projectIds = Array.from(new Set([
    ...(assigned.data || []).map((r: any) => r.project_id),
    ...(owned.data || []).map((r: any) => r.id),
    ...(mine.data || []).map((r: any) => r.project_id),
  ]))

  const [tasks, projects, milestones, availability] = await Promise.all([
    ctx.admin.from('tasks').select('id, name, status, priority, due_date, start_date, project_id').eq('assigned_to', ctx.userId).gte('due_date', from).lte('due_date', to),
    projectIds.length ? ctx.admin.from('projects').select('id, name, end_date, status').in('id', projectIds).gte('end_date', from).lte('end_date', to).is('archived_at', null) : Promise.resolve({ data: [] }),
    projectIds.length ? ctx.admin.from('milestones').select('id, name, date, status, project_id').in('project_id', projectIds).gte('date', from).lte('date', to) : Promise.resolve({ data: [] }),
    ctx.admin.from('user_availability').select('week_start_date, available_hours, schedule_data').eq('user_id', ctx.userId).gte('week_start_date', from.slice(0, 8) + '01').lte('week_start_date', to),
  ])

  const names: Record<string, string> = {}
  if (projectIds.length) {
    const { data } = await ctx.admin.from('projects').select('id, name').in('id', projectIds)
    ;(data || []).forEach((p: any) => { names[p.id] = p.name })
  }
  return ok({
    tasks: (tasks.data || []).map((t: any) => ({ ...t, project_name: names[t.project_id] || '' })),
    projectDeadlines: projects.data || [],
    milestones: (milestones.data || []).map((m: any) => ({ ...m, project_name: names[m.project_id] || '' })),
    availability: availability.data || [],
  })
})
