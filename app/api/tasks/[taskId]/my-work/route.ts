import { z } from 'zod'
import { api, readJson, requireTask, HttpError, ok } from '@/lib/api/context'
import { listAssignees, updateMyWork, ASSIGNEE_STATUSES } from '@/lib/task-assignees'

const schema = z.object({
  status: z.enum(ASSIGNEE_STATUSES).optional(),
  progress_percent: z.number().int().min(0).max(100).optional(),
  report: z.string().max(5000).optional().nullable(),
  blocker: z.string().max(2000).optional().nullable(),
})

// PATCH /api/tasks/[taskId]/my-work: the signed-in assignee updates THEIR OWN part of a shared task: status (done =
// "I have completed my part"), progress, work report and blocker. Nobody else's part can be changed here (the
// database refuses it too). When everyone has completed their part the task moves to review; if someone reopens
// theirs it goes back to in progress. Managers change other people's parts through the task's own actions.
export const PATCH = api<{ taskId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, schema)
  const { task } = await requireTask(ctx, params.taskId, 'contribute')
  const rows = (await listAssignees(ctx.admin, [task.id])).get(task.id) || []
  if (rows.length < 2) throw new HttpError(400, 'This task has a single assignee: use the task actions instead')
  const { assignees, summary, taskStatus } = await updateMyWork(ctx, task, rows, body)
  return ok({ assignees, summary, taskStatus })
})
