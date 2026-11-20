import { z } from 'zod'
import { api, ok, readJson, requireProject, check } from '@/lib/api/context'
import { computeSchedule, findConflicts, type ScheduleTask, type ScheduleDependency } from '@/lib/scheduling'
import { notify } from '@/lib/notify'

/* eslint-disable @typescript-eslint/no-explicit-any */
async function load(ctx: any, projectId: string) {
  const { data: tasks } = await ctx.admin.from('tasks')
    .select('id, name, status, start_date, due_date, assigned_to').eq('project_id', projectId)
  const ids = (tasks || []).map((t: any) => t.id)
  const { data: deps } = ids.length
    ? await ctx.admin.from('task_dependencies').select('task_id, depends_on_task_id').in('task_id', ids)
    : { data: [] }
  return { tasks: (tasks || []) as Array<ScheduleTask & { assigned_to: string | null }>, deps: (deps || []) as ScheduleDependency[] }
}

// GET /api/projects/[projectId]/schedule
//  milestones + dependencies for the Gantt chart, the dependencies that are violated today,
//  and the changes "reschedule from dependencies" would make
export const GET = api<{ projectId: string }>(async (_request, ctx, params) => {
  await requireProject(ctx, params.projectId, 'view')
  const [{ tasks, deps }, { data: milestones }] = await Promise.all([
    load(ctx, params.projectId),
    ctx.admin.from('milestones').select('id, name, date, status, color, client_visible').eq('project_id', params.projectId).order('date'),
  ])
  return ok({
    milestones: milestones || [],
    dependencies: deps,
    conflicts: findConflicts(tasks, deps),
    suggestions: computeSchedule(tasks, deps),
  })
})

// POST /api/projects/[projectId]/schedule { apply: boolean }
//  Project managers only. apply=false previews the changes; apply=true moves the tasks
//  (written with the caller's session, so the database rules still apply) and tells the assignees.
export const POST = api<{ projectId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({ apply: z.boolean().optional() }))
  const access = await requireProject(ctx, params.projectId, 'manage')
  const { tasks, deps } = await load(ctx, params.projectId)
  const changes = computeSchedule(tasks, deps)
  if (!body.apply || changes.length === 0) return ok({ applied: false, changes })

  for (const c of changes) {
    check(await ctx.supabase.from('tasks').update({ start_date: c.to_start, due_date: c.to_due }).eq('id', c.id).select('id').single())
    const assignee = tasks.find((t) => t.id === c.id)?.assigned_to
    await notify(ctx.admin, [assignee], {
      type: 'task_rescheduled', title: 'Task rescheduled',
      message: `"${c.name}" now runs ${c.to_start}${c.to_due ? ` to ${c.to_due}` : ''} (after ${c.because.join(', ')})`,
      link: `/projects/${params.projectId}?task=${c.id}`, projectId: params.projectId,
    }, ctx.userId)
  }
  return ok({ applied: true, changes, project: access.project.name })
})
