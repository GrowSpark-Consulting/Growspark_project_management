import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkDemoModeForDestructiveAction } from '@/lib/api-demo-guard'
import { api, readJson, requireTask, assertValidAssignee, HttpError, check, type ApiCtx } from '@/lib/api/context'
import { ALL_TASK_STATUSES, statusChangeNeedsReviewer, normalizeStatus } from '@/lib/task-rules'
import { afterTaskChange } from '@/lib/task-events'

const updateTaskSchema = z.object({
  name: z.string().trim().min(1, 'Task name is required').max(500).optional(),
  description: z.string().max(5000).optional().nullable(),
  status: z.enum(ALL_TASK_STATUSES).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  start_date: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
  estimated_hours: z.number().min(0).max(10000).optional().nullable(),
  actual_hours: z.number().min(0).max(10000).optional().nullable(),
  remaining_hours: z.number().min(0).max(10000).optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  reviewer_id: z.string().uuid().optional().nullable(),
  review_note: z.string().max(2000).optional().nullable(),
  progress_percent: z.number().int().min(0).max(100).optional(),
  display_order: z.number().min(0).optional(),
}).refine((d) => !(d.start_date && d.due_date) || d.due_date >= d.start_date, {
  message: 'Due date cannot be before start date', path: ['due_date'],
})

// Fields only the task creator or a project manager may change.
// The reviewer is chosen by a project manager only (also enforced by the database, G-1).
const DETAIL_FIELDS = ['name', 'priority', 'start_date', 'due_date', 'estimated_hours'] as const

async function updateTask(request: NextRequest, ctx: ApiCtx, params: { taskId: string }) {
  const { task, access, canReview, canEditDetails } = await requireTask(ctx, params.taskId, 'contribute')
  const body = await readJson(request, updateTaskSchema)

  for (const field of DETAIL_FIELDS) {
    if (body[field] !== undefined && body[field] !== task[field] && !canEditDetails) {
      throw new HttpError(403, `Only the task creator or a project manager can change ${field.replace('_', ' ')}`)
    }
  }

  if (body.assigned_to !== undefined && body.assigned_to !== task.assigned_to) {
    const selfAssign = body.assigned_to === ctx.userId && !task.assigned_to
    if (!canEditDetails && !selfAssign) {
      throw new HttpError(403, 'Only the task creator or a project manager can reassign this task')
    }
    if (body.assigned_to) await assertValidAssignee(ctx, task.project_id, body.assigned_to)
  }
  if (body.reviewer_id !== undefined && body.reviewer_id !== task.reviewer_id) {
    if (!access.canManage) throw new HttpError(403, 'Only a project manager can choose the reviewer')
    if (body.reviewer_id) await assertValidAssignee(ctx, task.project_id, body.reviewer_id)
  }
  const nextAssignee = body.assigned_to !== undefined ? body.assigned_to : task.assigned_to
  const nextReviewer = body.reviewer_id !== undefined ? body.reviewer_id : task.reviewer_id
  if (nextReviewer && nextReviewer === nextAssignee) {
    throw new HttpError(400, 'The reviewer cannot be the person assigned to the task')
  }

  const update: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) update[key] = value
  }
  if (update.status !== undefined) {
    const to = normalizeStatus(update.status as string)
    update.status = to
    if (statusChangeNeedsReviewer(task.status, to) && to !== task.status && !canReview) {
      throw new HttpError(403, 'Only the reviewer or a project manager can approve, request changes or reopen. Use "Submit for Review" instead.')
    }
    if (to === 'changes_requested' && !(update.review_note || '').toString().trim()) {
      throw new HttpError(400, 'A note is required when requesting changes')
    }
  }
  if (Object.keys(update).length === 0) throw new HttpError(400, 'No fields to update')
  update.updated_at = new Date().toISOString()

  const updated = check(await ctx.supabase
    .from('tasks').update(update).eq('id', task.id)
    .select(`*, created_by_user:user_profiles!created_by(id, name, email), assigned_to_user:user_profiles!assigned_to(id, name, email), project:projects(id, name)`)
    .single())

  await afterTaskChange(ctx, task, updated)
  return NextResponse.json({ success: true, task: updated, data: updated })
}

export const PUT = api<{ taskId: string }>(updateTask)
export const PATCH = api<{ taskId: string }>(updateTask)

// DELETE /api/tasks/[taskId] - task creator or project manager
export const DELETE = api<{ taskId: string }>(async (_request, ctx, params) => {
  const blocked = checkDemoModeForDestructiveAction('delete_task')
  if (blocked) return blocked
  const { task, access } = await requireTask(ctx, params.taskId, 'contribute')
  if (task.created_by !== ctx.userId && !access.canManage) {
    throw new HttpError(403, 'Only the task creator or a project manager can delete this task')
  }
  check(await ctx.supabase.from('tasks').delete().eq('id', task.id))
  return NextResponse.json({ success: true })
})
