/**
 * Task workflow rules shared by the API (friendly errors) and the UI (buttons).
 * The database trigger `enforce_task_status_transition` enforces the same rules.
 */

export const TASK_STATUSES = ['todo', 'in_progress', 'on_hold', 'review', 'changes_requested', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Values accepted by the API (legacy values are still valid in the database). */
export const ALL_TASK_STATUSES = [...TASK_STATUSES, 'backlog', 'blocked'] as const;

/** Status tones follow the Grow Spark Workspace badge mapping for Projects:
 *  neutral = not started, warning = at risk / on hold, danger = blocked / changes requested,
 *  info = in review, success = completed. In progress uses the moss primary tone. */
export type StatusTone = 'neutral' | 'primary' | 'warning' | 'info' | 'danger' | 'success';
export const TASK_STATUS_META: Record<string, { label: string; tone: StatusTone; badge: string; column: string; dropColumn: string }> = {
  todo: { label: 'To Do', tone: 'neutral', badge: 'bg-sunken text-ink-muted', column: 'bg-sunken', dropColumn: 'bg-hover' },
  in_progress: { label: 'In Progress', tone: 'primary', badge: 'bg-primary-soft text-primary', column: 'bg-primary-soft', dropColumn: 'bg-primary-soft ring-2 ring-primary' },
  on_hold: { label: 'On Hold', tone: 'warning', badge: 'bg-warning-soft text-warning', column: 'bg-warning-soft', dropColumn: 'bg-warning-soft ring-2 ring-warning' },
  review: { label: 'Ready for Review', tone: 'info', badge: 'bg-info-soft text-info', column: 'bg-info-soft', dropColumn: 'bg-info-soft ring-2 ring-info' },
  changes_requested: { label: 'Changes Requested', tone: 'danger', badge: 'bg-danger-soft text-danger', column: 'bg-danger-soft', dropColumn: 'bg-danger-soft ring-2 ring-danger' },
  done: { label: 'Done', tone: 'success', badge: 'bg-success-soft text-success', column: 'bg-success-soft', dropColumn: 'bg-success-soft ring-2 ring-success' },
  backlog: { label: 'To Do', tone: 'neutral', badge: 'bg-sunken text-ink-muted', column: 'bg-sunken', dropColumn: 'bg-hover' },
  blocked: { label: 'On Hold', tone: 'warning', badge: 'bg-warning-soft text-warning', column: 'bg-warning-soft', dropColumn: 'bg-warning-soft ring-2 ring-warning' },
};

/** Priority tones: urgent = danger, high = warning, medium = info, low = neutral. */
export const PRIORITY_TONE: Record<string, StatusTone> = { urgent: 'danger', high: 'warning', medium: 'info', low: 'neutral' };

export function statusLabel(status: string | null | undefined): string {
  return TASK_STATUS_META[status || 'todo']?.label || (status || '').replace(/_/g, ' ');
}

/** Normalise legacy values for display / grouping. */
export function normalizeStatus(status: string | null | undefined): TaskStatus {
  if (status === 'backlog' || !status) return 'todo';
  if (status === 'blocked') return 'on_hold';
  return status as TaskStatus;
}

export type TaskAction = 'start' | 'pause' | 'resume' | 'submit' | 'withdraw' | 'approve' | 'request_changes' | 'reopen';

export const TASK_ACTIONS: Record<TaskAction, { from: TaskStatus[] | 'any'; to: TaskStatus; label: string; reviewerOnly: boolean }> = {
  start: { from: ['todo', 'changes_requested'], to: 'in_progress', label: 'Start', reviewerOnly: false },
  pause: { from: ['in_progress'], to: 'on_hold', label: 'Pause', reviewerOnly: false },
  resume: { from: ['on_hold'], to: 'in_progress', label: 'Resume', reviewerOnly: false },
  submit: { from: ['in_progress', 'changes_requested', 'todo', 'on_hold'], to: 'review', label: 'Submit for Review', reviewerOnly: false },
  withdraw: { from: ['review'], to: 'in_progress', label: 'Withdraw', reviewerOnly: false },
  approve: { from: ['review'], to: 'done', label: 'Approve', reviewerOnly: true },
  request_changes: { from: ['review'], to: 'changes_requested', label: 'Request Changes', reviewerOnly: true },
  reopen: { from: ['done'], to: 'in_progress', label: 'Reopen', reviewerOnly: true },
};

/** Which status changes require reviewer/manager rights. */
export function statusChangeNeedsReviewer(from: string, to: string): boolean {
  return to === 'done' || to === 'changes_requested' || from === 'done';
}

export function availableActions(
  status: string,
  opts: { canContribute: boolean; canReview: boolean }
): TaskAction[] {
  const current = normalizeStatus(status);
  return (Object.keys(TASK_ACTIONS) as TaskAction[]).filter((action) => {
    const def = TASK_ACTIONS[action];
    if (def.reviewerOnly ? !opts.canReview : !opts.canContribute) return false;
    // managers may approve from any non-done state
    if (action === 'approve' && opts.canReview && current !== 'done') return true;
    return def.from === 'any' || (def.from as string[]).includes(current);
  });
}
