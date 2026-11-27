import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { api, readJson, requireProject, assertValidAssignee, HttpError, check } from '@/lib/api/context'
import { notify } from '@/lib/notify'
import { ALL_TASK_STATUSES } from '@/lib/task-rules'

const createTaskSchema = z.object({
  name: z.string().trim().min(1, 'Task name is required').max(500),
  description: z.string().max(5000).optional().nullable(),
  project_id: z.string().uuid('Invalid project ID'),
  parent_task_id: z.string().uuid().optional().nullable(),
  status: z.enum(ALL_TASK_STATUSES).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  start_date: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
  estimated_hours: z.number().min(0).max(10000).optional().nullable(),
  assigned_to: z.string().uuid('Invalid assignee ID').optional().nullable(),
  reviewer_id: z.string().uuid('Invalid reviewer ID').optional().nullable(),
}).refine((d) => !(d.start_date && d.due_date) || d.due_date >= d.start_date, {
  message: 'Due date cannot be before start date', path: ['due_date'],
})

// POST /api/tasks - create a task or subtask (any project team member)
export const POST = api(async (request: NextRequest, ctx) => {
  const body = await readJson(request, createTaskSchema)
  const access = await requireProject(ctx, body.project_id, 'contribute')

  if (body.parent_task_id) {
    const { data: parent } = await ctx.admin
      .from('tasks').select('id, project_id, parent_task_id').eq('id', body.parent_task_id).maybeSingle()
    if (!parent || parent.project_id !== body.project_id) throw new HttpError(400, 'Parent task must be in the same project')
    if (parent.parent_task_id) throw new HttpError(400, 'Subtasks cannot have their own subtasks')
  }
  if (body.assigned_to) {
    // Employees assign tasks to themselves only; a project manager can assign anyone on the team
    if (body.assigned_to !== ctx.userId && !access.canManage) throw new HttpError(403, 'You can only assign tasks to yourself')
    await assertValidAssignee(ctx, body.project_id, body.assigned_to)
  }
  if (body.reviewer_id) {
    // The reviewer is chosen by a project manager only (also enforced by the database, G-1)
    if (!access.canManage) throw new HttpError(403, 'Only a project manager can choose the reviewer')
    await assertValidAssignee(ctx, body.project_id, body.reviewer_id)
    if (body.reviewer_id === body.assigned_to) throw new HttpError(400, 'The reviewer cannot be the person assigned to the task')
  }

  // Employees can't create tasks directly in review/done states
  let status = body.status === 'backlog' || !body.status ? 'todo' : body.status === 'blocked' ? 'on_hold' : body.status
  if (!access.canManage && ['review', 'changes_requested', 'done'].includes(status)) status = 'todo'

  const task = check(await ctx.supabase
    .from('tasks')
    .insert({
      name: body.name,
      description: body.description || null,
      project_id: body.project_id,
      parent_task_id: body.parent_task_id || null,
      status,
      priority: body.priority || 'medium',
      start_date: body.start_date || null,
      due_date: body.due_date || null,
      estimated_hours: body.estimated_hours ?? null,
      remaining_hours: body.estimated_hours ?? null,
      actual_hours: 0,
      created_by: ctx.userId,
      assigned_to: body.assigned_to || null,
      reviewer_id: body.reviewer_id || null,
    })
    .select(`*, created_by_user:user_profiles!created_by(id, name, email), assigned_to_user:user_profiles!assigned_to(id, name, email), project:projects(id, name)`)
    .single())

  // Creator joins the team if not already a member
  const { data: existing } = await ctx.admin
    .from('project_assignments').select('id, removed_at')
    .eq('project_id', body.project_id).eq('user_id', ctx.userId).maybeSingle()
  if (!existing) {
    await ctx.admin.from('project_assignments').insert({
      project_id: body.project_id, user_id: ctx.userId, role_in_project: 'collaborator', assigned_by: ctx.userId,
    })
  } else if (existing.removed_at) {
    await ctx.admin.from('project_assignments').update({ removed_at: null }).eq('id', existing.id)
  }

  if (task.assigned_to && task.assigned_to !== ctx.userId) {
    await notify(ctx.admin, [task.assigned_to], {
      type: 'task_assigned',
      title: 'New task assigned to you',
      message: `${ctx.user.name || 'Someone'} assigned you "${task.name}" in ${access.project.name}`,
      link: `/projects/${body.project_id}?task=${task.id}`,
      projectId: body.project_id,
    })
  }

  // keep the legacy { success, task } shape used by existing UI
  return NextResponse.json({ success: true, task, data: task }, { status: 201 })
})
