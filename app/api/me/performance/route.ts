import { api, ok, weekStart, addDays } from '@/lib/api/context'
import { normalizeStatus } from '@/lib/task-rules'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/me/performance?weeks=12
export const GET = api(async (request, ctx) => {
  const weeks = Math.min(52, Math.max(1, Number(new URL(request.url).searchParams.get('weeks')) || 12))
  const firstWeek = addDays(weekStart(), -7 * (weeks - 1))
  const [tasks, entries] = await Promise.all([
    ctx.admin.from('tasks').select('id, status, due_date, completed_at, updated_at, project_id').eq('assigned_to', ctx.userId),
    ctx.admin.from('time_entries').select('hours_logged, week_start_date, project_id').eq('user_id', ctx.userId).gte('week_start_date', firstWeek),
  ])
  const list = (tasks.data || []).map((t: any) => ({ ...t, status: normalizeStatus(t.status), doneOn: (t.completed_at || t.updated_at || '').slice(0, 10) }))
  const done = list.filter((t: any) => t.status === 'done')
  const withDue = done.filter((t: any) => t.due_date)
  const onTime = withDue.filter((t: any) => t.doneOn && t.doneOn <= t.due_date.slice(0, 10)).length

  const byProject: Record<string, { project_id: string; hours: number; tasksDone: number }> = {}
  ;(entries.data || []).forEach((e: any) => {
    const p = byProject[e.project_id] || (byProject[e.project_id] = { project_id: e.project_id, hours: 0, tasksDone: 0 })
    p.hours += Number(e.hours_logged || 0)
  })
  done.forEach((t: any) => {
    const p = byProject[t.project_id] || (byProject[t.project_id] = { project_id: t.project_id, hours: 0, tasksDone: 0 })
    p.tasksDone += 1
  })
  const projectIds = Object.keys(byProject)
  const names: Record<string, string> = {}
  if (projectIds.length) {
    const { data } = await ctx.admin.from('projects').select('id, name').in('id', projectIds)
    ;(data || []).forEach((p: any) => { names[p.id] = p.name })
  }

  const weekly = Array.from({ length: weeks }, (_, i) => {
    const ws = addDays(firstWeek, i * 7)
    const we = addDays(ws, 6)
    return {
      week: ws,
      hours: Math.round((entries.data || []).filter((e: any) => e.week_start_date === ws).reduce((s: number, e: any) => s + Number(e.hours_logged || 0), 0) * 100) / 100,
      tasksDone: done.filter((t: any) => t.doneOn >= ws && t.doneOn <= we).length,
    }
  })
  const hoursLogged = weekly.reduce((s, w) => s + w.hours, 0)

  return ok({
    tasksCompleted: done.length,
    tasksPending: list.length - done.length,
    onTimeRate: withDue.length ? Math.round((onTime / withDue.length) * 100) : null,
    hoursLogged: Math.round(hoursLogged * 100) / 100,
    avgHoursPerWeek: Math.round((hoursLogged / weeks) * 10) / 10,
    byProject: Object.values(byProject).map((p) => ({ ...p, hours: Math.round(p.hours * 100) / 100, project_name: names[p.project_id] || 'Project' }))
      .sort((a, b) => b.hours - a.hours),
    weekly,
  })
})
