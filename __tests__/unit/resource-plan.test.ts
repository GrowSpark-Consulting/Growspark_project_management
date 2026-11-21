import { describe, it, expect } from 'vitest'
import { planWeeks, isMonday, loadStatus, personWeeks, roundHours, MAX_PLAN_WEEKS } from '@/lib/resource-plan'

describe('planWeeks', () => {
  it('returns consecutive Mondays', () => {
    expect(planWeeks('2026-11-23', 3)).toEqual(['2026-11-23', '2026-11-30', '2026-12-07'])
  })
  it('crosses month and year ends', () => {
    expect(planWeeks('2026-12-28', 2)).toEqual(['2026-12-28', '2027-01-04'])
  })
  it('keeps the count between 1 and the maximum', () => {
    expect(planWeeks('2026-11-23', 0)).toHaveLength(1)
    expect(planWeeks('2026-11-23', 99)).toHaveLength(MAX_PLAN_WEEKS)
  })
})

describe('isMonday', () => {
  it('accepts Mondays only, in YYYY-MM-DD form', () => {
    expect(isMonday('2026-11-23')).toBe(true)
    expect(isMonday('2026-11-24')).toBe(false)
    expect(isMonday('2026-02-30')).toBe(false)
    expect(isMonday('23-11-2026')).toBe(false)
  })
})

describe('loadStatus', () => {
  it('free when nothing is planned, over above availability, near from 90%', () => {
    expect(loadStatus(0, 40)).toBe('free')
    expect(loadStatus(20, 40)).toBe('ok')
    expect(loadStatus(36, 40)).toBe('near')
    expect(loadStatus(40, 40)).toBe('near')
    expect(loadStatus(40.5, 40)).toBe('over')
    expect(loadStatus(1, 0)).toBe('over')
  })
})

describe('personWeeks', () => {
  const weeks = ['2026-11-23', '2026-11-30']
  const allocations = [
    { task_id: 'here-1', week_start_date: '2026-11-23', assigned_user_id: 'u1', allocated_hours: '12.5' },
    { task_id: 'here-2', week_start_date: '2026-11-23', assigned_user_id: 'u1', allocated_hours: 4 },
    { task_id: 'elsewhere', week_start_date: '2026-11-23', assigned_user_id: 'u1', allocated_hours: 30 },
    { task_id: 'elsewhere', week_start_date: '2026-11-30', assigned_user_id: 'u1', allocated_hours: 10 },
    { task_id: 'here-1', week_start_date: '2026-11-23', assigned_user_id: 'u2', allocated_hours: 99 },
  ]
  const result = personWeeks({
    personId: 'u1', weeks, allocations, projectTaskIds: new Set(['here-1', 'here-2']),
    availability: new Map([['u1|2026-11-30', 20]]), defaultAvailable: 40,
  })
  it('splits hours between this project and other projects, per week, for that person only', () => {
    expect(result[0]).toEqual({ week: '2026-11-23', here: 16.5, other: 30, total: 46.5, available: 40, status: 'over' })
  })
  it('uses the person\'s own availability where it is set', () => {
    expect(result[1]).toEqual({ week: '2026-11-30', here: 0, other: 10, total: 10, available: 20, status: 'ok' })
  })
})

describe('roundHours', () => {
  it('keeps two decimals', () => {
    expect(roundHours(1.005 + 2)).toBe(3.01)
    expect(roundHours(Number('abc'))).toBe(0)
  })
})
