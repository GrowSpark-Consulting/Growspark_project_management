/**
 * Per-project task board columns (projects.board_columns).
 * The six statuses are fixed by the task workflow; a project can rename, reorder and hide
 * their columns and set a work-in-progress (WIP) limit. Unknown or missing entries fall back
 * to the defaults, so a stored setting can never lose a status.
 */
import { z } from 'zod';
import { TASK_STATUSES, TASK_STATUS_META, type TaskStatus } from '@/lib/task-rules';

export interface BoardColumn {
  status: TaskStatus;
  label: string;
  hidden: boolean;
  wip_limit: number | null;
}

export const boardColumnsSchema = z.array(z.object({
  status: z.enum(TASK_STATUSES),
  label: z.string().trim().min(1, 'Column name is required').max(40),
  hidden: z.boolean().optional(),
  wip_limit: z.number().int().min(1).max(999).nullable().optional(),
})).length(TASK_STATUSES.length, 'Include each of the six status columns once')
  .refine((cols) => new Set(cols.map((c) => c.status)).size === TASK_STATUSES.length, 'Each status column must appear exactly once')
  .refine((cols) => cols.some((c) => !c.hidden), 'At least one column must stay visible');

export const defaultBoardColumns = (): BoardColumn[] =>
  TASK_STATUSES.map((status) => ({ status, label: TASK_STATUS_META[status].label, hidden: false, wip_limit: null }));

/** Stored value (or null) → all six columns, in the stored order, defaults filled in. */
export function normalizeBoardColumns(raw: unknown): BoardColumn[] {
  const defaults = defaultBoardColumns();
  if (!Array.isArray(raw)) return defaults;
  const seen = new Set<string>();
  const out: BoardColumn[] = [];
  for (const item of raw) {
    const status = (item as { status?: string })?.status;
    if (!status || seen.has(status) || !(TASK_STATUSES as readonly string[]).includes(status)) continue;
    seen.add(status);
    const d = defaults.find((x) => x.status === status)!;
    const label = typeof (item as BoardColumn).label === 'string' && (item as BoardColumn).label.trim() ? (item as BoardColumn).label.trim().slice(0, 40) : d.label;
    const wip = Number((item as BoardColumn).wip_limit);
    out.push({ status: status as TaskStatus, label, hidden: !!(item as BoardColumn).hidden, wip_limit: Number.isInteger(wip) && wip > 0 ? wip : null });
  }
  for (const d of defaults) if (!seen.has(d.status)) out.push(d);
  return out;
}
