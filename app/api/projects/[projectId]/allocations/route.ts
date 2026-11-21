import { z } from 'zod'
import { api, ok, readJson, requireProject, check, HttpError, weekStart, type ApiCtx, type ProjectAccess } from '@/lib/api/context'
import { DEFAULT_WEEKLY_HOURS } from '@/lib/constants'
import { MAX_PLAN_WEEKS, MAX_WEEK_HOURS, isMonday, planWeeks, personWeeks, roundHours, type AllocationRow } from '@/lib/resource-plan'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Project resource plan: hours per person, task and week (task_week_allocations), against each
// person's availability and what they are already planned for on other projects. Project managers
// only. Writes use the service role after the project check (the table's policies only let the
// assignee or a superadmin write).

const none = { data: [] as any[] }

async function buildPlan(ctx: ApiCtx, access: ProjectAccess, weeks: string[]) {
  const project = access.project
  const [{ data: tasks }, { data: team }] = await Promise.all([
    ctx.admin.from('tasks').select('id, name, status, assigned_to, estimated_hours, due_date, parent_task_id').eq('project_id', project.id).order('created_at'),
    ctx.admin.from('project_assignments').select('user_id').eq('project_id', project.id).is('removed_at', null),
  ])
  const allTasks: any[] = tasks || []
  const taskIds = allTasks.map((t) => t.id)
  const open = allTasks.filter((t) => t.status !== 'done')
  const peopleIds = [...new Set([...(team || []).map((m: any) => m.user_id), ...open.map((t) => t.assigned_to).filter(Boolean)])] as string[]

  const [{ data: profiles }, { data: projectAllocs }, { data: peopleAllocs }, { data: availability }] = await Promise.all([
    peopleIds.length ? ctx.admin.from('user_profiles').select('id, name').in('id', peopleIds) : none,
    taskIds.length ? ctx.admin.from('task_week_allocations').select('task_id, week_start_date, assigned_user_id, allocated_hours').in('task_id', taskIds) : none,
    peopleIds.length ? ctx.admin.from('task_week_allocations').select('task_id, week_start_date, assigned_user_id, allocated_hours').in('assigned_user_id', peopleIds).in('week_start_date', weeks) : none,
    peopleIds.length ? ctx.admin.from('user_availability').select('user_id, week_start_date, available_hours').in('user_id', peopleIds).in('week_start_date', weeks) : none,
  ])

  const projectTaskIds = new Set<string>(taskIds)
  const avail = new Map<string, number>((availability || []).map((a: any) => [`${a.user_id}|${a.week_start_date}`, Number(a.available_hours) || 0]))
  const mine: AllocationRow[] = projectAllocs || []
  const nameOf = new Map<string, string>((profiles || []).map((p: any) => [p.id, p.name || 'Unnamed']))

  const people = peopleIds
    .map((id) => ({
      id,
      name: nameOf.get(id) || 'Unnamed',
      weeks: personWeeks({ personId: id, weeks, allocations: peopleAllocs || [], projectTaskIds, availability: avail, defaultAvailable: DEFAULT_WEEKLY_HOURS }),
      tasks: open.filter((t) => t.assigned_to === id).map((t) => {
        const rows = mine.filter((a) => a.task_id === t.id && a.assigned_user_id === id)
        return {
          id: t.id,
          name: t.name,
          status: t.status,
          due_date: t.due_date,
          is_subtask: !!t.parent_task_id,
          estimated_hours: t.estimated_hours == null ? null : Number(t.estimated_hours),
          planned_total: roundHours(rows.reduce((s, a) => s + (Number(a.allocated_hours) || 0), 0)),
          hours: Object.fromEntries(weeks.map((w) => [w, roundHours(Number(rows.find((a) => a.week_start_date === w)?.allocated_hours) || 0)])),
        }
      }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    project: { id: project.id, name: project.name, status: project.status, start_date: project.start_date, end_date: project.end_date, archived: !!project.archived_at },
    weeks,
    canEdit: access.canManage && !project.archived_at && project.status !== 'complete',
    defaultAvailable: DEFAULT_WEEKLY_HOURS,
    people,
    unassigned: open.filter((t) => !t.assigned_to).map((t) => ({ id: t.id, name: t.name, status: t.status, estimated_hours: t.estimated_hours == null ? null : Number(t.estimated_hours) })),
  }
}

function weeksFrom(fromParam: string | null | undefined, countParam: unknown): string[] {
  const from = fromParam || weekStart()
  if (!isMonday(from)) throw new HttpError(400, 'The plan must start on a Monday (YYYY-MM-DD)')
  return planWeeks(from, Number(countParam) || 6)
}

// GET /api/projects/[projectId]/allocations?from=YYYY-MM-DD (a Monday)&weeks=1..12
export const GET = api<{ projectId: string }>(async (request, ctx, params) => {
  const access = await requireProject(ctx, params.projectId, 'view')
  if (!access.canManage) throw new HttpError(403, 'Only a project manager can see the resource plan')
  const url = new URL(request.url)
  return ok(await buildPlan(ctx, access, weeksFrom(url.searchParams.get('from'), url.searchParams.get('weeks'))))
})

// PUT /api/projects/[projectId]/allocations { changes: [{ taskId, weekStartDate, hours }], from?, weeks? }
// Hours are planned for the task's current assignee; 0 removes the allocation.
export const PUT = api<{ projectId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    changes: z.array(z.object({
      taskId: z.string().uuid(),
      weekStartDate: z.string(),
      hours: z.number().min(0, 'Hours cannot be negative').max(MAX_WEEK_HOURS, `At most ${MAX_WEEK_HOURS} hours in a week`),
    })).min(1).max(500),
    from: z.string().optional(),
    weeks: z.number().int().min(1).max(MAX_PLAN_WEEKS).optional(),
  }))
  const access = await requireProject(ctx, params.projectId, 'manage')
  if (access.project.archived_at) throw new HttpError(409, 'Project is archived (read-only)')

  // Last change per cell wins
  const cells = new Map<string, { taskId: string; week: string; hours: number }>()
  for (const c of body.changes) {
    if (!isMonday(c.weekStartDate)) throw new HttpError(400, `${c.weekStartDate} is not the Monday that starts a week`)
    cells.set(`${c.taskId}|${c.weekStartDate}`, { taskId: c.taskId, week: c.weekStartDate, hours: roundHours(c.hours) })
  }
  const ids = [...new Set([...cells.values()].map((c) => c.taskId))]
  const { data: tasks } = await ctx.admin.from('tasks').select('id, name, status, assigned_to, project_id').in('id', ids)
  const byId = new Map<string, any>((tasks || []).map((t: any) => [t.id, t]))
  for (const id of ids) {
    const t = byId.get(id)
    if (!t || t.project_id !== access.project.id) throw new HttpError(400, 'A task is not part of this project')
    if (t.status === 'done') throw new HttpError(400, `"${t.name}" is done; there is nothing left to plan`)
    if (!t.assigned_to) throw new HttpError(400, `Assign "${t.name}" to someone before planning hours`)
  }

  const now = new Date().toISOString()
  const upserts = [...cells.values()].filter((c) => c.hours > 0).map((c) => ({
    task_id: c.taskId, week_start_date: c.week, assigned_user_id: byId.get(c.taskId).assigned_to, allocated_hours: c.hours, updated_at: now,
  }))
  if (upserts.length) {
    check(await ctx.admin.from('task_week_allocations').upsert(upserts, { onConflict: 'task_id,week_start_date,assigned_user_id' }).select('id'))
  }
  for (const c of [...cells.values()].filter((x) => x.hours === 0)) {
    check(await ctx.admin.from('task_week_allocations').delete()
      .eq('task_id', c.taskId).eq('week_start_date', c.week).eq('assigned_user_id', byId.get(c.taskId).assigned_to))
  }
  return ok(await buildPlan(ctx, access, weeksFrom(body.from, body.weeks)))
})
