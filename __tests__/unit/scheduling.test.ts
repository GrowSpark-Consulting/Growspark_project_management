import { describe, it, expect } from 'vitest';
import { computeSchedule, findConflicts, addDaysIso, type ScheduleTask } from '@/lib/scheduling';

const t = (id: string, start: string | null, due: string | null, status = 'todo'): ScheduleTask => ({ id, name: `Task ${id}`, status, start_date: start, due_date: due });

describe('computeSchedule', () => {
  it('moves a task that starts before its predecessor ends, keeping its length', () => {
    const changes = computeSchedule(
      [t('a', '2026-12-01', '2026-12-05'), t('b', '2026-12-03', '2026-12-08')],
      [{ task_id: 'b', depends_on_task_id: 'a' }]
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: 'b', to_start: '2026-12-06', to_due: '2026-12-11', shift_days: 3, because: ['Task a'] });
  });

  it('leaves a correctly planned task alone', () => {
    expect(computeSchedule([t('a', '2026-12-01', '2026-12-05'), t('b', '2026-12-06', '2026-12-09')], [{ task_id: 'b', depends_on_task_id: 'a' }])).toEqual([]);
  });

  it('cascades down a chain', () => {
    const changes = computeSchedule(
      [t('a', '2026-12-01', '2026-12-05'), t('b', '2026-12-02', '2026-12-04'), t('c', '2026-12-03', '2026-12-04')],
      [{ task_id: 'b', depends_on_task_id: 'a' }, { task_id: 'c', depends_on_task_id: 'b' }]
    );
    expect(changes.map((c) => [c.id, c.to_start, c.to_due])).toEqual([['b', '2026-12-06', '2026-12-08'], ['c', '2026-12-09', '2026-12-10']]);
  });

  it('waits for the latest of several predecessors', () => {
    const changes = computeSchedule(
      [t('a', '2026-12-01', '2026-12-03'), t('b', '2026-12-01', '2026-12-10'), t('c', '2026-12-02', '2026-12-04')],
      [{ task_id: 'c', depends_on_task_id: 'a' }, { task_id: 'c', depends_on_task_id: 'b' }]
    );
    expect(changes[0]).toMatchObject({ id: 'c', to_start: '2026-12-11', because: ['Task b'] });
  });

  it('never moves finished or undated tasks', () => {
    const changes = computeSchedule(
      [t('a', '2026-12-01', '2026-12-05'), t('b', '2026-12-02', '2026-12-03', 'done'), t('c', null, null)],
      [{ task_id: 'b', depends_on_task_id: 'a' }, { task_id: 'c', depends_on_task_id: 'a' }]
    );
    expect(changes).toEqual([]);
  });

  it('uses the start date when a predecessor has no due date, and shifts a task without a due date', () => {
    const changes = computeSchedule([t('a', '2026-12-04', null), t('b', '2026-12-01', null)], [{ task_id: 'b', depends_on_task_id: 'a' }]);
    expect(changes[0]).toMatchObject({ to_start: '2026-12-05', to_due: null });
  });

  it('ignores cycles instead of looping', () => {
    const changes = computeSchedule(
      [t('a', '2026-12-01', '2026-12-02'), t('b', '2026-12-01', '2026-12-02')],
      [{ task_id: 'a', depends_on_task_id: 'b' }, { task_id: 'b', depends_on_task_id: 'a' }]
    );
    expect(changes).toEqual([]);
  });

  it('handles month and year ends', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    const [c] = computeSchedule([t('a', '2026-12-28', '2026-12-31'), t('b', '2026-12-29', '2027-01-02')], [{ task_id: 'b', depends_on_task_id: 'a' }]);
    expect(c).toMatchObject({ to_start: '2027-01-01', to_due: '2027-01-05' });
  });
});

describe('findConflicts', () => {
  it('lists dependencies whose successor starts too early', () => {
    const tasks = [t('a', '2026-12-01', '2026-12-05'), t('b', '2026-12-05', '2026-12-08'), t('c', '2026-12-06', '2026-12-08')];
    const deps = [{ task_id: 'b', depends_on_task_id: 'a' }, { task_id: 'c', depends_on_task_id: 'a' }];
    expect(findConflicts(tasks, deps)).toEqual([{ task_id: 'b', depends_on_task_id: 'a' }]);
  });
});
