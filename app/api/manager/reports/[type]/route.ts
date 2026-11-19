import { api, ok, getScope, requireManager, HttpError, today } from '@/lib/api/context'
import { normalizeStatus } from '@/lib/task-rules'
import { loadFinancials } from '@/lib/project-financials'

/* eslint-disable @typescript-eslint/no-explicit-any */
const TYPES = ['project-performance', 'project-completion', 'employee-performance', 'time', 'budget', 'risks', 'workload'] as const

// GET /api/manager/reports/[type]?from=&to= - rows for on-screen tables and CSV export
export const GET = api<{ type: string }>(async (request, ctx, params) => {
  requireManager(ctx)
  if (!TYPES.includes(params.type as any)) throw new HttpError(404, 'Unknown report')
  const sp = new URL(request.url).searchParams
  const to = (sp.get('to') || today()).slice(0, 10)
  const from = (sp.get('from') || new Date(Date.now() - 90 * 86400000).toISOString()).slice(0, 10)
  const scope = await getScope(ctx)
  const ids = scope.projectIds
  if (!ids.length) return ok([], 200, { from, to })
  const t = today()

  const [projectsRes, tasksRes, entriesRes, settingsRes] = await Promise.all([
    ctx.admin.from('projects').select('id, name, status, priority, start_date, end_date, estimated_hours, archived_at, accounts!projects_account_id_fkey(name)').in('id', ids),
    ctx.admin.from('tasks').select('id, project_id, status, assigned_to, due_date, completed_at, updated_at, estimated_hours, parent_task_id').in('project_id', ids),
    ctx.admin.from('time_entries').select('user_id, project_id, hours_logged, entry_date').in('project_id', ids).gte('entry_date', from).lte('entry_date', to),
    ctx.admin.from('app_settings').select('default_hourly_rate').maybeSingle(),
  ])
  const projects = projectsRes.data || []
  const tasks = (tasksRes.data || []).map((x: any) => ({ ...x, status: normalizeStatus(x.status), doneOn: (x.completed_at || x.updated_at || '').slice(0, 10) }))
  const entries = entriesRes.data || []
  const acct = (p: any) => (Array.isArray(p.accounts) ? p.accounts[0] : p.accounts)?.name || ''
  const hoursFor = (pid: string) => Math.round(entries.filter((e: any) => e.project_id === pid).reduce((s: number, e: any) => s + Number(e.hours_logged || 0), 0) * 100) / 100

  let rows: any[] = []
  switch (params.type) {
    case 'project-performance':
    case 'project-completion':
      rows = projects.map((p: any) => {
        const pt = tasks.filter((x: any) => x.project_id === p.id && !x.parent_task_id)
        const done = pt.filter((x: any) => x.status === 'done').length
        return {
          project: p.name, account: acct(p), status: p.status, priority: p.priority,
          start_date: p.start_date, end_date: p.end_date,
          tasks_total: pt.length, tasks_done: done, completion_percent: pt.length ? Math.round((done / pt.length) * 100) : 0,
          overdue_tasks: pt.filter((x: any) => x.status !== 'done' && x.due_date && x.due_date.slice(0, 10) < t).length,
          estimated_hours: p.estimated_hours, logged_hours: hoursFor(p.id),
          delayed: p.status !== 'complete' && !!p.end_date && p.end_date.slice(0, 10) < t ? 'yes' : 'no',
          archived: p.archived_at ? 'yes' : 'no',
        }
      })
      if (params.type === 'project-completion') rows = rows.filter((r) => r.status === 'complete' || r.completion_percent > 0)
      break
    case 'employee-performance':
    case 'workload': {
      const userIds = Array.from(new Set([...tasks.map((x: any) => x.assigned_to), ...entries.map((e: any) => e.user_id)].filter(Boolean))) as string[]
      const { data: people } = userIds.length ? await ctx.admin.from('user_profiles').select('id, name, is_client').in('id', userIds) : { data: [] }
      rows = (people || []).filter((p: any) => !p.is_client).map((p: any) => {
        const mine = tasks.filter((x: any) => x.assigned_to === p.id)
        const doneInRange = mine.filter((x: any) => x.status === 'done' && x.doneOn >= from && x.doneOn <= to)
        const withDue = doneInRange.filter((x: any) => x.due_date)
        const onTime = withDue.filter((x: any) => x.doneOn <= x.due_date.slice(0, 10)).length
        const open = mine.filter((x: any) => x.status !== 'done')
        return {
          employee: p.name,
          tasks_completed: doneInRange.length,
          on_time_percent: withDue.length ? Math.round((onTime / withDue.length) * 100) : '',
          open_tasks: open.length,
          overdue_tasks: open.filter((x: any) => x.due_date && x.due_date.slice(0, 10) < t).length,
          in_review: open.filter((x: any) => x.status === 'review').length,
          hours_logged: Math.round(entries.filter((e: any) => e.user_id === p.id).reduce((s: number, e: any) => s + Number(e.hours_logged || 0), 0) * 100) / 100,
        }
      }).sort((a: any, b: any) => b.tasks_completed - a.tasks_completed)
      break
    }
    case 'time': {
      const names: Record<string, string> = Object.fromEntries(projects.map((p: any) => [p.id, p.name]))
      const userIds = Array.from(new Set(entries.map((e: any) => e.user_id))) as string[]
      const { data: people } = userIds.length ? await ctx.admin.from('user_profiles').select('id, name').in('id', userIds) : { data: [] }
      const pn: Record<string, string> = Object.fromEntries((people || []).map((p: any) => [p.id, p.name]))
      const grouped: Record<string, any> = {}
      entries.forEach((e: any) => {
        const key = `${e.user_id}|${e.project_id}`
        const g = grouped[key] || (grouped[key] = { employee: pn[e.user_id] || '', project: names[e.project_id] || '', hours: 0, entries: 0 })
        g.hours = Math.round((g.hours + Number(e.hours_logged || 0)) * 100) / 100
        g.entries += 1
      })
      rows = Object.values(grouped).sort((a: any, b: any) => b.hours - a.hours)
      break
    }
    case 'budget': {
      const defaultRate = Number(settingsRes.data?.default_hourly_rate || 0)
      // Only budgets the caller may see (project managers / org-wide viewers), enforced by the database (G-6)
      const [financials, { data: allEntries }] = await Promise.all([
        loadFinancials(ctx.supabase, ids),
        ctx.admin.from('time_entries').select('project_id, hours_logged').in('project_id', ids),
      ])
      rows = projects.filter((p: any) => financials[p.id]?.budget != null).map((p: any) => {
        const fin = financials[p.id]
        const budget = Number(fin.budget)
        const hours = (allEntries || []).filter((e: any) => e.project_id === p.id).reduce((s: number, e: any) => s + Number(e.hours_logged || 0), 0)
        const rate = Number(fin.hourly_rate ?? defaultRate)
        const spent = Math.round(hours * rate * 100) / 100
        return { project: p.name, account: acct(p), currency: fin.currency || 'INR', budget, hourly_rate: rate, hours_logged: Math.round(hours * 100) / 100, spent, remaining: Math.round((budget - spent) * 100) / 100, percent_used: budget > 0 ? Math.round((spent / budget) * 100) : '' }
      })
      break
    }
    case 'risks': {
      const { data } = await ctx.admin.from('project_issues').select('title, content, kind, severity, status, created_at, resolved_at, project_id').in('project_id', ids).order('created_at', { ascending: false })
      const names: Record<string, string> = Object.fromEntries(projects.map((p: any) => [p.id, p.name]))
      rows = (data || []).map((r: any) => ({ project: names[r.project_id], type: r.kind, severity: r.severity, status: r.status, title: r.title || r.content.slice(0, 80), created: r.created_at?.slice(0, 10), resolved: r.resolved_at?.slice(0, 10) || '' }))
      break
    }
  }
  return ok(rows, 200, { from, to, type: params.type })
})
