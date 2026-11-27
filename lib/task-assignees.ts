/**
 * Tasks with several assignees. One task, one row per person in `task_assignees`, each with their own status,
 * progress, report and blocker. The database keeps tasks.assigned_to (the first assignee) and tasks.progress_percent
 * (the average) in step; this file holds the rules the API applies before it writes (the database checks them too).
 *
 *   Who may be assigned: an employee can put only themselves on a task; a project manager can assign themselves and
 *   people whose highest role level is LOWER than their own; superadmins are unrestricted. Same level or above: no.
 *   A task is complete when every assignee has completed their part: the app then moves it to review (a manager can
 *   still set any status directly).
 */
import { HttpError, assertValidAssignee, check, type ApiCtx, type ProjectAccess } from '@/lib/api/context';
import { notify, getProjectManagerIds } from '@/lib/notify';
import { normalizeStatus } from '@/lib/task-rules';
import { afterTaskChange } from '@/lib/task-events';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MAX_ASSIGNEES = 10;
export const ASSIGNEE_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type AssigneeStatus = (typeof ASSIGNEE_STATUSES)[number];

export interface AssigneeRow {
  task_id: string;
  user_id: string;
  assigned_at: string;
  status: AssigneeStatus;
  progress_percent: number;
  report: string | null;
  blocker: string | null;
  completed_at: string | null;
  updated_at: string;
  user: { id: string; name: string; email: string; image: string | null } | null;
}

/** The people on each task, earliest first, with name and picture. */
export async function listAssignees(admin: any, taskIds: string[]): Promise<Map<string, AssigneeRow[]>> {
  const out = new Map<string, AssigneeRow[]>();
  if (taskIds.length === 0) return out;
  const { data } = await admin
    .from('task_assignees')
    .select('task_id, user_id, assigned_at, status, progress_percent, report, blocker, completed_at, updated_at, user:user_profiles!user_id(id, name, email, image)')
    .in('task_id', taskIds)
    .order('assigned_at', { ascending: true });
  for (const row of (data || []) as any[]) {
    const list = out.get(row.task_id) || [];
    list.push({ ...row, user: Array.isArray(row.user) ? row.user[0] ?? null : row.user ?? null });
    out.set(row.task_id, list);
  }
  return out;
}

/** The role level of each person: their highest roles.hierarchy_level (superadmins: 100). */
export async function roleLevels(admin: any, userIds: string[]): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return levels;
  const [{ data: profiles }, { data: roles }] = await Promise.all([
    admin.from('user_profiles').select('id, is_superadmin').in('id', ids),
    admin.from('user_roles').select('user_id, roles!user_roles_role_id_fkey(hierarchy_level)').in('user_id', ids),
  ]);
  for (const id of ids) levels.set(id, 0);
  for (const ur of (roles || []) as any[]) {
    const role = Array.isArray(ur.roles) ? ur.roles[0] : ur.roles;
    const level = Number(role?.hierarchy_level ?? 0);
    if (level > (levels.get(ur.user_id) ?? 0)) levels.set(ur.user_id, level);
  }
  for (const p of (profiles || []) as any[]) if (p.is_superadmin) levels.set(p.id, 100);
  return levels;
}

/** Throws unless the signed-in person may put `candidates` on a task. */
export async function assertCanAssign(ctx: ApiCtx, access: ProjectAccess, projectId: string, candidates: string[], reviewerId?: string | null) {
  const others = candidates.filter((id) => id !== ctx.userId);
  if (others.length > 0 && !ctx.isSuperadmin) {
    if (!access.canManage) throw new HttpError(403, 'You can only assign tasks to yourself');
    const levels = await roleLevels(ctx.admin, [ctx.userId, ...others]);
    const mine = levels.get(ctx.userId) ?? 0;
    for (const id of others) {
      if (mine <= (levels.get(id) ?? 0)) {
        throw new HttpError(403, 'You can only assign tasks to people below you in the role hierarchy, or to yourself');
      }
    }
  }
  for (const id of candidates) {
    await assertValidAssignee(ctx, projectId, id);
    if (reviewerId && reviewerId === id) throw new HttpError(400, 'The reviewer cannot be the person assigned to the task');
  }
}

/**
 * Make the task's assignees exactly `nextIds`: add the new people, remove the ones left out. Employees may only add or
 * remove themselves; the hierarchy rule applies to everyone added. Notifies the people added and removed.
 */
export async function setTaskAssignees(ctx: ApiCtx, task: any, access: ProjectAccess, nextIds: string[]) {
  const wanted = [...new Set(nextIds)];
  if (wanted.length > MAX_ASSIGNEES) throw new HttpError(400, `A task can have at most ${MAX_ASSIGNEES} assignees`);
  const current = (await listAssignees(ctx.admin, [task.id])).get(task.id) || [];
  const currentIds = current.map((r) => r.user_id);
  const toAdd = wanted.filter((id) => !currentIds.includes(id));
  const toRemove = currentIds.filter((id) => !wanted.includes(id));
  if (toAdd.length === 0 && toRemove.length === 0) return { added: [], removed: [] };

  await assertCanAssign(ctx, access, task.project_id, toAdd, task.reviewer_id);
  if (toRemove.length > 0 && !access.canManage) {
    if (task.created_by !== ctx.userId || toRemove.some((id) => id !== ctx.userId)) {
      throw new HttpError(403, 'Only the task creator or a project manager can remove an assignee');
    }
  }

  // Add before removing, so the task is never left without anyone part-way
  for (const id of toAdd) check(await ctx.supabase.from('task_assignees').insert({ task_id: task.id, user_id: id }));
  for (const id of toRemove) check(await ctx.supabase.from('task_assignees').delete().eq('task_id', task.id).eq('user_id', id));

  const activity = [
    ...toAdd.map((id) => ({ task_id: task.id, project_id: task.project_id, actor_id: ctx.userId, action: 'assignee_added', to_value: id })),
    ...toRemove.map((id) => ({ task_id: task.id, project_id: task.project_id, actor_id: ctx.userId, action: 'assignee_removed', from_value: id })),
  ];
  await ctx.admin.from('task_activity').insert(activity);

  const link = `/projects/${task.project_id}?task=${task.id}`;
  const actor = ctx.user?.name || 'Someone';
  await notify(ctx.admin, toAdd, {
    type: 'task_assigned', title: 'New task assigned to you',
    message: `${actor} assigned you "${task.name}"`, link, projectId: task.project_id,
  }, ctx.userId);
  await notify(ctx.admin, toRemove, {
    type: 'task_unassigned', title: 'Removed from a task',
    message: `${actor} removed you from "${task.name}"`, link, projectId: task.project_id,
  }, ctx.userId);
  return { added: toAdd, removed: toRemove };
}

/** Overall progress and who has finished, for the task views. */
export function summarize(rows: AssigneeRow[]) {
  const total = rows.length;
  const done = rows.filter((r) => r.status === 'done').length;
  const progress = total ? Math.round(rows.reduce((sum, r) => sum + r.progress_percent, 0) / total) : 0;
  return { total, done, progress, allDone: total > 0 && done === total };
}

export interface MyWorkInput {
  status?: AssigneeStatus;
  progress_percent?: number;
  report?: string | null;
  blocker?: string | null;
}

/**
 * The signed-in assignee updates THEIR OWN part of a shared task (status, progress, report, blocker). Moves the task
 * itself on when that follows: everyone done -> review, someone reopens their part -> in progress, first work -> in
 * progress. Notifies the people who need to know (a new blocker; a part completed), once. `rows` = the task's assignees.
 */
export async function updateMyWork(ctx: ApiCtx, task: any, rows: AssigneeRow[], body: MyWorkInput) {
  const mine = rows.find((r) => r.user_id === ctx.userId);
  if (!mine) throw new HttpError(403, 'You are not assigned to this task');
  const current = normalizeStatus(task.status);
  if (current === 'done') throw new HttpError(409, 'This task is done. Ask a project manager to reopen it.');

  // What the row becomes
  const patch: Record<string, unknown> = {};
  if (body.progress_percent !== undefined) patch.progress_percent = body.progress_percent;
  if (body.report !== undefined) patch.report = body.report?.trim() || null;
  if (body.blocker !== undefined) patch.blocker = body.blocker?.trim() || null;
  let status = body.status;
  if (status === undefined) {
    // A blocker blocks; clearing it unblocks; progress on an untouched or finished part means it is being worked on
    if (typeof patch.blocker === 'string' && mine.status !== 'done') status = 'blocked';
    else if (body.blocker !== undefined && !patch.blocker && mine.status === 'blocked') status = 'in_progress';
    else if (body.progress_percent !== undefined && (mine.status === 'todo' || mine.status === 'done') && body.progress_percent < 100) status = 'in_progress';
  }
  if (status !== undefined) patch.status = status;
  if (status === 'done') patch.progress_percent = 100;
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nothing to update');

  // What the task becomes once this part changes
  const next: AssigneeRow[] = rows.map((r) => (r.user_id === ctx.userId ? { ...r, ...(patch as Partial<AssigneeRow>) } : r));
  const summary = summarize(next);
  let taskStatus: string | null = null;
  if (summary.allDone && current !== 'review') taskStatus = 'review';
  else if (!summary.allDone && current === 'review') taskStatus = 'in_progress';
  else if (current === 'todo' && next.some((r) => r.status !== 'todo')) taskStatus = 'in_progress';

  // Task first: it can be refused (for example, a task whose dependencies are not finished cannot start), and then
  // nothing is saved
  let updatedTask: any = null;
  if (taskStatus) {
    updatedTask = check(await ctx.supabase.from('tasks').update({ status: taskStatus, updated_at: new Date().toISOString() }).eq('id', task.id).select('*').single());
  }
  check(await ctx.supabase.from('task_assignees').update(patch).eq('task_id', task.id).eq('user_id', ctx.userId));

  const link = `/projects/${task.project_id}?task=${task.id}`;
  const actor = ctx.user?.name || 'Someone';
  if (patch.report !== undefined || patch.blocker !== undefined) {
    const note = [patch.report ? `Report: ${String(patch.report).slice(0, 300)}` : null, patch.blocker ? `Blocker: ${String(patch.blocker).slice(0, 300)}` : null].filter(Boolean).join(' | ');
    await ctx.admin.from('task_activity').insert({ task_id: task.id, project_id: task.project_id, actor_id: ctx.userId, action: 'report_updated', note: note || 'Cleared' });
  }
  // Important updates reach the people who need them, once: a new blocker, or someone completing their part
  if (typeof patch.blocker === 'string' && patch.blocker !== mine.blocker) {
    const managers = await getProjectManagerIds(ctx.admin, task.project_id);
    await notify(ctx.admin, [...rows.map((r) => r.user_id), task.created_by, ...managers], {
      type: 'task_blocker', title: 'Blocker on a shared task',
      message: `${actor} is blocked on "${task.name}": ${String(patch.blocker).slice(0, 200)}`, link, projectId: task.project_id,
    }, ctx.userId);
  } else if (patch.status === 'done' && mine.status !== 'done' && !summary.allDone) {
    const managers = await getProjectManagerIds(ctx.admin, task.project_id);
    await notify(ctx.admin, [task.created_by, ...managers], {
      type: 'task_part_done', title: 'Part of a shared task completed',
      message: `${actor} completed their part of "${task.name}" (${summary.done} of ${summary.total} done)`, link, projectId: task.project_id,
    }, ctx.userId);
  }
  if (updatedTask) await afterTaskChange(ctx, task, updatedTask);

  const fresh = (await listAssignees(ctx.admin, [task.id])).get(task.id) || [];
  return { assignees: fresh, summary: summarize(fresh), taskStatus: updatedTask?.status || task.status, task: updatedTask };
}

/** Ids of the tasks a person is on (any of the assignees). */
export async function assignedTaskIds(admin: any, userId: string): Promise<string[]> {
  const { data } = await admin.from('task_assignees').select('task_id').eq('user_id', userId);
  return (data || []).map((r: any) => r.task_id);
}

/** A `.or(...)` filter for "tasks this person is on": the first assignee, or any assignee of a shared task. */
export function onTaskFilter(userId: string, taskIds: string[]): string {
  return taskIds.length ? `assigned_to.eq.${userId},id.in.(${taskIds.join(',')})` : `assigned_to.eq.${userId}`;
}

/** task id -> the ids of everyone on it (for workload views and reminders). */
export async function assigneeIdsByTask(admin: any, taskIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (taskIds.length === 0) return out;
  const { data } = await admin.from('task_assignees').select('task_id, user_id').in('task_id', taskIds);
  for (const r of (data || []) as any[]) out.set(r.task_id, [...(out.get(r.task_id) || []), r.user_id]);
  return out;
}
