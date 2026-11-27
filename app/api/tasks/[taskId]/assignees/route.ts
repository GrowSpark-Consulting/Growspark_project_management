import { api, requireTask, ok } from '@/lib/api/context'
import { listAssignees, summarize } from '@/lib/task-assignees'

// GET /api/tasks/[taskId]/assignees: everyone on the task with their own status, progress, report, blocker and the
// hours they logged, plus the task's overall progress and combined time. Anyone who can see the project can read it.
export const GET = api<{ taskId: string }>(async (_request, ctx, params) => {
  const { task } = await requireTask(ctx, params.taskId, 'view')
  const rows = (await listAssignees(ctx.admin, [task.id])).get(task.id) || []

  const { data: entries } = await ctx.admin.from('time_entries').select('user_id, hours_logged').eq('task_id', task.id)
  const byUser = new Map<string, number>()
  for (const e of (entries || []) as any[]) byUser.set(e.user_id, (byUser.get(e.user_id) || 0) + Number(e.hours_logged || 0))
  const round = (n: number) => Math.round(n * 100) / 100

  const assignees = rows.map((r) => ({ ...r, hours_logged: round(byUser.get(r.user_id) || 0) }))
  const totalHours = round([...byUser.values()].reduce((sum, h) => sum + h, 0))
  const mine = rows.some((r) => r.user_id === ctx.userId)
  return ok({ assignees, summary: { ...summarize(rows), hours_logged: totalHours }, mine })
})
