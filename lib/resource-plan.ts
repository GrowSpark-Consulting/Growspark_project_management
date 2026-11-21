/**
 * Project resource plan: how many hours each person is planned to spend on each task, per week,
 * against what they have available. Allocations are rows of task_week_allocations (task × week ×
 * person), the same rows the capacity screens already add up. Pure functions, shared by the API
 * (app/api/projects/[projectId]/allocations) and its tests.
 */

export const MAX_PLAN_WEEKS = 12;
export const MAX_WEEK_HOURS = 168;

export type LoadStatus = 'free' | 'ok' | 'near' | 'over';

export type AllocationRow = { task_id: string; week_start_date: string; assigned_user_id: string | null; allocated_hours: number | string };

export type PersonWeek = {
  week: string;
  here: number;      // planned on this project
  other: number;     // planned on every other project
  total: number;     // here + other
  available: number; // from user_availability, or the default week
  status: LoadStatus;
};

/** Hours rounded to 2 decimals (numeric(…,2) in the database). */
export function roundHours(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** `count` consecutive Monday dates starting at `fromMonday` (YYYY-MM-DD). */
export function planWeeks(fromMonday: string, count: number): string[] {
  const n = Math.max(1, Math.min(MAX_PLAN_WEEKS, Math.floor(count) || 1));
  const start = new Date(`${fromMonday}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i * 7);
    return d.toISOString().slice(0, 10);
  });
}

/** True for a YYYY-MM-DD date that is a Monday (weeks start on Monday, like timesheets). */
export function isMonday(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date && d.getUTCDay() === 1;
}

/** Over: more than available. Near: 90% or more. Free: nothing planned at all. */
export function loadStatus(total: number, available: number): LoadStatus {
  if (total <= 0) return 'free';
  if (total > available) return 'over';
  if (available > 0 && total >= available * 0.9) return 'near';
  return 'ok';
}

/**
 * Per person and week: hours planned here, elsewhere, in total, and the status against availability.
 * `projectTaskIds` tells which allocations belong to this project.
 */
export function personWeeks(opts: {
  personId: string;
  weeks: string[];
  allocations: AllocationRow[];          // every allocation of the people involved, in these weeks
  projectTaskIds: Set<string>;
  availability: Map<string, number>;     // key `${personId}|${week}`
  defaultAvailable: number;
}): PersonWeek[] {
  return opts.weeks.map((week) => {
    let here = 0;
    let other = 0;
    for (const a of opts.allocations) {
      if (a.assigned_user_id !== opts.personId || a.week_start_date !== week) continue;
      const h = Number(a.allocated_hours) || 0;
      if (opts.projectTaskIds.has(a.task_id)) here += h; else other += h;
    }
    const available = opts.availability.get(`${opts.personId}|${week}`) ?? opts.defaultAvailable;
    const total = roundHours(here + other);
    return { week, here: roundHours(here), other: roundHours(other), total, available: roundHours(available), status: loadStatus(total, available) };
  });
}
