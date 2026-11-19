import { z } from 'zod'
import { api, readJson, requireTask, HttpError, check, ok, weekStart, today } from '@/lib/api/context'
import { TASK_ACTIONS, normalizeStatus, type TaskAction } from '@/lib/task-rules'
import { afterTaskChange } from '@/lib/task-events'

const schema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'submit', 'withdraw', 'approve', 'request_changes', 'reopen']),
  note: z.string().max(2000).optional().nullable(),
  timer: z.boolean().optional(),
})

// POST /api/tasks/[taskId]/status - task workflow actions (+ optional timer)
export const POST = api<{ taskId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, schema)
  const { task, canReview } = await requireTask(ctx, params.taskId, 'contribute')
  const action = body.action as TaskAction
  const def = TASK_ACTIONS[action]
  const current = normalizeStatus(task.status)

  if (def.reviewerOnly && !canReview) {
    throw new HttpError(403, 'Only the reviewer or a project manager can do this')
  }
  const fromOk = def.from === 'any' || (def.from as string[]).includes(current) || (action === 'approve' && canReview && current !== 'done')
  if (!fromOk) throw new HttpError(409, `Cannot ${def.label.toLowerCase()} a task that is ${current.replace('_', ' ')}`)
  if (action === 'request_changes' && !body.note?.trim()) throw new HttpError(400, 'Please describe the changes you need')
  if (action === 'withdraw' && task.assigned_to && task.assigned_to !== ctx.userId && !canReview) {
    throw new HttpError(403, 'Only the assignee can withdraw a submission')
  }

  const update: Record<string, unknown> = { status: def.to, updated_at: new Date().toISOString() }
  if (body.note !== undefined && body.note !== null) update.review_note = body.note
  else if (action === 'submit' || action === 'approve') update.review_note = null

  // Timer: start / stop the user's clock session linked to this task
  let timer: { started?: boolean; loggedHours?: number } | undefined
  if (body.timer && (action === 'start' || action === 'resume')) {
    const { data: active } = await ctx.admin.from('clock_sessions').select('id, task_id').eq('user_id', ctx.userId).eq('is_active', true).maybeSingle()
    if (active) throw new HttpError(409, 'You are already clocked in. Pause your current task or clock out first.')
    check(await ctx.supabase.from('clock_sessions').insert({
      user_id: ctx.userId, clock_in_time: new Date().toISOString(), is_active: true, task_id: task.id,
    }))
    timer = { started: true }
  }
  if (body.timer && (action === 'pause' || action === 'submit')) {
    const { data: active } = await ctx.admin.from('clock_sessions').select('*').eq('user_id', ctx.userId).eq('is_active', true).maybeSingle()
    if (active) {
      const now = new Date()
      const hours = Math.max(0.01, Math.round(((now.getTime() - new Date(active.clock_in_time).getTime()) / 36e5) * 100) / 100)
      check(await ctx.supabase.from('clock_sessions').update({ is_active: false, clock_out_time: now.toISOString() }).eq('id', active.id))
      const logged = Math.min(hours, 24)
      check(await ctx.supabase.from('time_entries').insert({
        user_id: ctx.userId, project_id: task.project_id, task_id: task.id, hours_logged: logged,
        entry_date: today(), week_start_date: weekStart(), description: `Timer: ${task.name}`,
        clock_session_id: active.id, clock_in_time: active.clock_in_time, clock_out_time: now.toISOString(),
      }))
      await ctx.admin.from('tasks').update({ actual_hours: Number(task.actual_hours || 0) + logged }).eq('id', task.id)
      timer = { loggedHours: logged }
    }
  }

  const updated = check(await ctx.supabase.from('tasks').update(update).eq('id', task.id).select('*').single())
  await afterTaskChange(ctx, task, updated)
  return ok({ task: updated, timer })
})
