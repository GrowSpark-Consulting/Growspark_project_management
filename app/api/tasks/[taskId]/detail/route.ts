import { api, requireTask, ok } from '@/lib/api/context'
import { availableActions } from '@/lib/task-rules'
import { listAssignees, summarize } from '@/lib/task-assignees'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/tasks/[taskId]/detail - everything the task drawer needs in one call
export const GET = api<{ taskId: string }>(async (_request, ctx, params) => {
  const { task, access, canReview, canEditDetails } = await requireTask(ctx, params.taskId, 'view')
  const db = ctx.admin

  const [subtasks, deps, dependents, comments, files, activity, people, assigneeMap, taskHours] = await Promise.all([
    db.from('tasks').select('id, name, status, assigned_to, due_date, progress_percent').eq('parent_task_id', task.id).order('created_at'),
    db.from('task_dependencies').select('depends_on_task_id, dependency_type, tasks!task_dependencies_depends_on_task_id_fkey(id, name, status)').eq('task_id', task.id),
    db.from('task_dependencies').select('task_id, tasks!task_dependencies_task_id_fkey(id, name, status)').eq('depends_on_task_id', task.id),
    db.from('comments').select('id, parent_id, content, mentions, created_at, updated_at, created_by').eq('task_id', task.id).order('created_at'),
    db.from('project_files').select('id, file_name, mime_type, size_bytes, uploaded_by, created_at, client_visible').eq('task_id', task.id).order('created_at', { ascending: false }),
    db.from('task_activity').select('id, action, from_value, to_value, note, actor_id, created_at').eq('task_id', task.id).order('created_at', { ascending: false }).limit(100),
    db.from('project_assignments').select('user_id').eq('project_id', task.project_id).is('removed_at', null),
    listAssignees(db, [task.id]),
    db.from('time_entries').select('user_id, hours_logged').eq('task_id', task.id),
  ])
  // Everyone on the task with their own part and the hours they logged (shared tasks have several assignees)
  const hoursBy = new Map<string, number>()
  ;(taskHours.data || []).forEach((e: any) => hoursBy.set(e.user_id, (hoursBy.get(e.user_id) || 0) + Number(e.hours_logged || 0)))
  const assigneeRows = (assigneeMap.get(task.id) || []).map((a) => ({ ...a, hours_logged: Math.round((hoursBy.get(a.user_id) || 0) * 100) / 100 }))
  const shared = assigneeRows.length >= 2

  // Resolve names for every user referenced
  const userIds = new Set<string>()
  ;[task.assigned_to, task.created_by, task.reviewer_id, access.project.assigned_user_id, access.project.created_by]
    .forEach((id) => id && userIds.add(id))
  ;(people.data || []).forEach((p: any) => userIds.add(p.user_id))
  ;(comments.data || []).forEach((c: any) => c.created_by && userIds.add(c.created_by))
  ;(activity.data || []).forEach((a: any) => a.actor_id && userIds.add(a.actor_id))
  const UUID = /^[0-9a-f-]{36}$/i
  ;(activity.data || []).forEach((a: any) => {
    if (['assigned', 'assignee_added', 'assignee_removed'].includes(a.action)) [a.from_value, a.to_value].forEach((v) => v && UUID.test(v) && userIds.add(v))
  })
  ;(files.data || []).forEach((f: any) => f.uploaded_by && userIds.add(f.uploaded_by))
  ;(subtasks.data || []).forEach((s: any) => s.assigned_to && userIds.add(s.assigned_to))
  assigneeRows.forEach((a) => userIds.add(a.user_id))
  ;(taskHours.data || []).forEach((e: any) => e.user_id && userIds.add(e.user_id))
  const { data: profiles } = userIds.size
    ? await db.from('user_profiles').select('id, name, image, is_client').in('id', Array.from(userIds))
    : { data: [] as any[] }
  const users: Record<string, { id: string; name: string; image: string | null }> = {}
  ;(profiles || []).forEach((p: any) => { users[p.id] = { id: p.id, name: p.name, image: p.image } })

  const teamIds = new Set<string>((people.data || []).map((p: any) => p.user_id))
  ;[access.project.assigned_user_id, access.project.created_by].forEach((id) => id && teamIds.add(id))
  const team = Array.from(teamIds)
    .filter((id) => (profiles || []).find((p: any) => p.id === id && !p.is_client))
    .map((id) => users[id]).filter(Boolean)

  return ok({
    task,
    project: { id: access.project.id, name: access.project.name, status: access.project.status, archived_at: access.project.archived_at },
    permissions: {
      canContribute: access.canContribute,
      canManage: access.canManage,
      canReview,
      canEditDetails,
      // On a shared task each person works through their own part (My part); the task-level buttons left are the
      // reviewer's (approve, request changes, reopen)
      actions: availableActions(task.status, { canContribute: access.canContribute, canReview })
        .filter((a) => !shared || ['approve', 'request_changes', 'reopen'].includes(a)),
      isAssignee: assigneeRows.some((a) => a.user_id === ctx.userId),
    },
    assignees: assigneeRows,
    assigneeSummary: { ...summarize(assigneeRows), hours_logged: Math.round([...hoursBy.values()].reduce((x, y) => x + y, 0) * 100) / 100 },
    shared,
    subtasks: subtasks.data || [],
    dependencies: (deps.data || []).map((d: any) => ({ ...(Array.isArray(d.tasks) ? d.tasks[0] : d.tasks), type: d.dependency_type })).filter((d: any) => d.id),
    dependents: (dependents.data || []).map((d: any) => (Array.isArray(d.tasks) ? d.tasks[0] : d.tasks)).filter(Boolean),
    comments: comments.data || [],
    files: files.data || [],
    activity: activity.data || [],
    users,
    team,
    me: ctx.userId,
  })
})
