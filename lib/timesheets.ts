/* eslint-disable @typescript-eslint/no-explicit-any */
import { addDays } from '@/lib/api/context'

/** Build a weekly grid (7 days) from time entries. */
export async function buildWeek(db: any, userId: string, weekStartIso: string, projectFilter?: string[] | null) {
  let query = db
    .from('time_entries')
    .select('id, entry_date, hours_logged, description, project_id, task_id, projects!time_entries_project_id_fkey(name), tasks!time_entries_task_id_fkey(name)')
    .eq('user_id', userId)
    .gte('entry_date', weekStartIso)
    .lte('entry_date', addDays(weekStartIso, 6))
    .order('entry_date')
  if (projectFilter) query = query.in('project_id', projectFilter.length ? projectFilter : ['00000000-0000-0000-0000-000000000000'])
  const { data } = await query
  const days: Record<string, number> = {}
  for (let i = 0; i < 7; i++) days[addDays(weekStartIso, i)] = 0
  const entries = (data || []).map((e: any) => {
    const proj = Array.isArray(e.projects) ? e.projects[0] : e.projects
    const task = Array.isArray(e.tasks) ? e.tasks[0] : e.tasks
    days[e.entry_date] = Math.round(((days[e.entry_date] || 0) + Number(e.hours_logged || 0)) * 100) / 100
    return { id: e.id, date: e.entry_date, hours: Number(e.hours_logged), description: e.description, project_id: e.project_id, project_name: proj?.name || '', task_name: task?.name || null }
  })
  const total = Math.round(entries.reduce((s: number, e: any) => s + e.hours, 0) * 100) / 100
  return { days, entries, total }
}
