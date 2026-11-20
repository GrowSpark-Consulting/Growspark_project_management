/**
 * Dependency-driven scheduling (pure functions, no I/O).
 *
 * A task can't start before the tasks it depends on have finished: its start must be at least the
 * day after the latest due date of its predecessors. `computeSchedule` shifts such tasks later
 * (keeping their length) and cascades the change to everything downstream. Tasks that are already
 * done, or have no dates, are never moved. Dates are YYYY-MM-DD strings.
 */

export interface ScheduleTask {
  id: string;
  name: string;
  status: string;
  start_date: string | null;
  due_date: string | null;
}

export interface ScheduleDependency {
  task_id: string; // the dependent (successor)
  depends_on_task_id: string; // the predecessor
}

export interface ScheduleChange {
  id: string;
  name: string;
  from_start: string;
  from_due: string | null;
  to_start: string;
  to_due: string | null;
  shift_days: number;
  because: string[]; // names of the predecessors that force the move
}

const DAY = 24 * 60 * 60 * 1000;
const toUtc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDaysIso = (iso: string, days: number) => fromUtc(toUtc(iso) + days * DAY);
export const diffDays = (a: string, b: string) => Math.round((toUtc(a) - toUtc(b)) / DAY);

/** Tasks in an order where every predecessor comes before its successors. Cycles are left out. */
function topoOrder(ids: string[], deps: ScheduleDependency[]): string[] {
  const set = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>();
  for (const d of deps) {
    if (!set.has(d.task_id) || !set.has(d.depends_on_task_id)) continue;
    indeg.set(d.task_id, (indeg.get(d.task_id) || 0) + 1);
    next.set(d.depends_on_task_id, [...(next.get(d.depends_on_task_id) || []), d.task_id]);
  }
  const queue = ids.filter((id) => (indeg.get(id) || 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const n of next.get(id) || []) {
      indeg.set(n, (indeg.get(n) || 0) - 1);
      if ((indeg.get(n) || 0) === 0) queue.push(n);
    }
  }
  return order;
}

export function computeSchedule(tasks: ScheduleTask[], deps: ScheduleDependency[]): ScheduleChange[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Working copy of dates: moves cascade to successors
  const cur = new Map(tasks.map((t) => [t.id, { start: t.start_date, due: t.due_date }]));
  const preds = new Map<string, string[]>();
  for (const d of deps) preds.set(d.task_id, [...(preds.get(d.task_id) || []), d.depends_on_task_id]);

  const changes: ScheduleChange[] = [];
  for (const id of topoOrder(tasks.map((t) => t.id), deps)) {
    const t = byId.get(id)!;
    const c = cur.get(id)!;
    if (t.status === 'done' || !c.start) continue;

    // Earliest allowed start: the day after the latest end among the predecessors
    let earliest: string | null = null;
    const blockers: Array<{ name: string; end: string }> = [];
    for (const pid of preds.get(id) || []) {
      const p = byId.get(pid);
      const pc = cur.get(pid);
      if (!p || !pc) continue;
      const end = pc.due || pc.start;
      if (!end) continue;
      const free = addDaysIso(end, 1);
      if (!earliest || free > earliest) earliest = free;
      blockers.push({ name: p.name, end });
    }
    if (!earliest || c.start >= earliest) continue;

    const shift = diffDays(earliest, c.start);
    const newDue = c.due ? addDaysIso(c.due, shift) : null;
    changes.push({
      id, name: t.name, from_start: c.start, from_due: c.due, to_start: earliest, to_due: newDue, shift_days: shift,
      because: blockers.filter((b) => addDaysIso(b.end, 1) === earliest).map((b) => b.name),
    });
    cur.set(id, { start: earliest, due: newDue });
  }
  return changes;
}

/** Dependencies that are currently violated (the successor starts before its predecessor ends). */
export function findConflicts(tasks: ScheduleTask[], deps: ScheduleDependency[]): ScheduleDependency[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return deps.filter((d) => {
    const s = byId.get(d.task_id);
    const p = byId.get(d.depends_on_task_id);
    const end = p?.due_date || p?.start_date;
    return !!s?.start_date && !!end && s.status !== 'done' && s.start_date <= end;
  });
}
