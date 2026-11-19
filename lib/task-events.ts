/**
 * Side effects after task changes (notifications). Shared by PATCH /api/tasks/[id]
 * and POST /api/tasks/[id]/status so Kanban drags and buttons behave the same.
 */
import { notify, getProjectManagerIds } from '@/lib/notify';
import { statusLabel } from '@/lib/task-rules';
import type { ApiCtx } from '@/lib/api/context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function afterTaskChange(ctx: ApiCtx, before: any, after: any): Promise<void> {
  const link = `/projects/${after.project_id}?task=${after.id}`;
  const actor = ctx.user?.name || 'Someone';

  if (after.assigned_to && after.assigned_to !== before.assigned_to) {
    await notify(ctx.admin, [after.assigned_to], {
      type: 'task_assigned', title: 'New task assigned to you',
      message: `${actor} assigned you "${after.name}"`, link, projectId: after.project_id,
    }, ctx.userId);
  }

  if (after.status === before.status) return;

  if (after.status === 'review') {
    const reviewers = after.reviewer_id ? [after.reviewer_id] : await getProjectManagerIds(ctx.admin, after.project_id);
    await notify(ctx.admin, reviewers, {
      type: 'task_review', title: 'Task ready for review',
      message: `${actor} submitted "${after.name}" for review${after.review_note ? `: ${after.review_note}` : ''}`,
      link, projectId: after.project_id,
    }, ctx.userId);
  } else if (after.status === 'done' || after.status === 'changes_requested') {
    await notify(ctx.admin, [after.assigned_to, after.created_by], {
      type: after.status === 'done' ? 'task_approved' : 'task_changes_requested',
      title: after.status === 'done' ? 'Task approved' : 'Changes requested',
      message: after.status === 'done'
        ? `${actor} approved "${after.name}"`
        : `${actor} requested changes on "${after.name}": ${after.review_note || ''}`,
      link, projectId: after.project_id,
    }, ctx.userId);
  } else if (before.status === 'done') {
    await notify(ctx.admin, [after.assigned_to], {
      type: 'task_reopened', title: 'Task reopened',
      message: `${actor} reopened "${after.name}" (${statusLabel(after.status)})`, link, projectId: after.project_id,
    }, ctx.userId);
  }
}
