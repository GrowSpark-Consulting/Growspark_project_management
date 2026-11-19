import { z } from 'zod'
import { api, readJson, requireTask, HttpError, check, ok, assertUuid } from '@/lib/api/context'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/tasks/[taskId]/dependencies
export const GET = api<{ taskId: string }>(async (_request, ctx, params) => {
  const { task } = await requireTask(ctx, params.taskId, 'view')
  const { data } = await ctx.admin
    .from('task_dependencies')
    .select('depends_on_task_id, dependency_type, tasks!task_dependencies_depends_on_task_id_fkey(id, name, status)')
    .eq('task_id', task.id)
  return ok((data || []).map((d: any) => ({ ...(Array.isArray(d.tasks) ? d.tasks[0] : d.tasks), type: d.dependency_type })))
})

// POST /api/tasks/[taskId]/dependencies { depends_on_task_id }
export const POST = api<{ taskId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({ depends_on_task_id: z.string().uuid() }))
  const { task, canEditDetails } = await requireTask(ctx, params.taskId, 'contribute')
  if (!canEditDetails) throw new HttpError(403, 'Only the task creator or a project manager can change dependencies')
  const { data: other } = await ctx.admin.from('tasks').select('id, project_id').eq('id', body.depends_on_task_id).maybeSingle()
  if (!other || other.project_id !== task.project_id) throw new HttpError(400, 'Dependencies must be within the same project')
  const row = check(await ctx.supabase
    .from('task_dependencies')
    .insert({ task_id: task.id, depends_on_task_id: body.depends_on_task_id, dependency_type: 'finish_to_start' })
    .select().single())
  return ok(row, 201)
})

// DELETE /api/tasks/[taskId]/dependencies?dependsOn=<taskId>
export const DELETE = api<{ taskId: string }>(async (request, ctx, params) => {
  const dependsOn = assertUuid(new URL(request.url).searchParams.get('dependsOn'), 'dependsOn')
  const { task, canEditDetails } = await requireTask(ctx, params.taskId, 'contribute')
  if (!canEditDetails) throw new HttpError(403, 'Only the task creator or a project manager can change dependencies')
  check(await ctx.supabase.from('task_dependencies').delete().eq('task_id', task.id).eq('depends_on_task_id', dependsOn))
  return ok({ removed: true })
})
