import { api, ok, today } from '@/lib/api/context'
import { normalizeStatus, TASK_STATUSES } from '@/lib/task-rules'
import { Prisma } from '@/lib/db/generated/client'
import { withSystem, schemaName } from '@/lib/db'
import { wantsPage, readPage, pageInfo, searchTerm } from '@/lib/pagination'
import { listAssignees, summarize } from '@/lib/task-assignees'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/me/tasks?view=assigned|created|in_progress|review|changes_requested|done|overdue|to_review
//                   &projectId=&priority=&status=&due=today|week|overdue&q=
//                   &page=&pageSize= (20, 50, 100; without them up to 1000 rows, as before)
//
// The view, filters, search, order and page are applied by the database; only the page's rows are read.
// meta: { counts (per view, before filters), projects (for the project filter), pagination }
const VIEWS = ['assigned', 'created', 'in_progress', 'review', 'changes_requested', 'done', 'overdue', 'to_review'] as const
type View = (typeof VIEWS)[number]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRIORITIES = ['urgent', 'high', 'medium', 'low']

export const GET = api(async (request, ctx) => {
  const sp = new URL(request.url).searchParams
  const view: View = (VIEWS as readonly string[]).includes(sp.get('view') || '') ? (sp.get('view') as View) : 'assigned'
  const t = today()
  const weekEnd = new Date(`${t}T00:00:00Z`); weekEnd.setUTCDate(weekEnd.getUTCDate() + 7)
  const endIso = weekEnd.toISOString().slice(0, 10)
  const paged = wantsPage(sp)
  const page = paged ? readPage(sp) : { page: 1, pageSize: 1000, from: 0, to: 999 }
  const me = ctx.userId

  const s = schemaName()
  const tbl = (name: string) => Prisma.raw(s ? `"${s}".${name}` : name)
  // Legacy statuses read as their current names (as normalizeStatus does)
  const norm = Prisma.sql`(case when tk.status is null or tk.status = 'backlog' then 'todo' when tk.status = 'blocked' then 'on_hold' else tk.status end)`
  const overdue = Prisma.sql`(tk.due_date < ${t}::date and ${norm} <> 'done')`
  // Mine: I am on the task (one of its assignees; tasks.assigned_to is the first of them)
  const mine = Prisma.sql`(tk.assigned_to = ${me}::uuid or exists (select 1 from ${tbl('task_assignees')} ta where ta.task_id = tk.id and ta.user_id = ${me}::uuid))`
  const viewSql: Record<View, Prisma.Sql> = {
    assigned: mine,
    created: Prisma.sql`tk.created_by = ${me}::uuid`,
    in_progress: Prisma.sql`${mine} and ${norm} = 'in_progress'`,
    review: Prisma.sql`${mine} and ${norm} = 'review'`,
    changes_requested: Prisma.sql`${mine} and ${norm} = 'changes_requested'`,
    done: Prisma.sql`${mine} and ${norm} = 'done'`,
    overdue: Prisma.sql`${mine} and ${overdue}`,
    to_review: Prisma.sql`tk.reviewer_id = ${me}::uuid and ${norm} = 'review' and not ${mine}`,
  }
  // Everything relevant to me: assigned to me, created by me, or waiting for my review; open projects only
  const base = Prisma.sql`from ${tbl('tasks')} tk join ${tbl('projects')} p on p.id = tk.project_id and p.archived_at is null
    where (${mine} or tk.created_by = ${me}::uuid or tk.reviewer_id = ${me}::uuid)`

  const filters: Prisma.Sql[] = [viewSql[view]]
  const projectId = sp.get('projectId')
  const priority = sp.get('priority')
  const status = sp.get('status')
  const due = sp.get('due')
  const q = searchTerm(sp)
  if (projectId && UUID.test(projectId)) filters.push(Prisma.sql`tk.project_id = ${projectId}::uuid`)
  if (priority && PRIORITIES.includes(priority)) filters.push(Prisma.sql`tk.priority = ${priority}`)
  if (status && (TASK_STATUSES as readonly string[]).includes(status)) filters.push(Prisma.sql`${norm} = ${status}`)
  if (q) filters.push(Prisma.sql`tk.name ilike ${'%' + q + '%'}`)
  if (due === 'today') filters.push(Prisma.sql`tk.due_date = ${t}::date`)
  if (due === 'overdue') filters.push(overdue)
  if (due === 'week') filters.push(Prisma.sql`tk.due_date between ${t}::date and ${endIso}::date`)
  const where = Prisma.join(filters, ' and ')

  const { ids, total, counts, projects } = await withSystem(async (tx) => {
    const idRows = await tx.$queryRaw<Array<{ id: string }>>`select tk.id ${base} and ${where}
      order by tk.due_date asc nulls last, tk.id limit ${page.pageSize} offset ${page.from}`
    const totalRows = await tx.$queryRaw<Array<{ n: number }>>`select count(*)::int as n ${base} and ${where}`
    const countRows = await tx.$queryRaw<Array<Record<View, number>>>`select
      (count(*) filter (where ${viewSql.assigned}))::int as assigned,
      (count(*) filter (where ${viewSql.created}))::int as created,
      (count(*) filter (where ${viewSql.in_progress}))::int as in_progress,
      (count(*) filter (where ${viewSql.review}))::int as review,
      (count(*) filter (where ${viewSql.changes_requested}))::int as changes_requested,
      (count(*) filter (where ${viewSql.done}))::int as done,
      (count(*) filter (where ${viewSql.overdue}))::int as overdue,
      (count(*) filter (where ${viewSql.to_review}))::int as to_review
      ${base}`
    const projectRows = await tx.$queryRaw<Array<{ id: string; name: string }>>`select distinct p.id, p.name ${base} order by p.name`
    return { ids: idRows.map((r) => r.id), total: totalRows[0]?.n ?? 0, counts: countRows[0], projects: projectRows }
  })

  const meta: Record<string, unknown> = { counts, projects }
  if (paged) meta.pagination = pageInfo(page, total)
  if (!ids.length) return ok([], 200, meta)

  // The page's rows, with their project, in the order chosen above
  const { data: rows } = await ctx.admin
    .from('tasks')
    .select('id, name, description, status, priority, progress_percent, start_date, due_date, estimated_hours, actual_hours, project_id, parent_task_id, assigned_to, created_by, reviewer_id, review_note, updated_at, projects!tasks_project_id_fkey(id, name, status, archived_at)')
    .in('id', ids)
  const byId = new Map((rows || []).map((r: any) => [r.id, r]))

  // Subtask counts for the page's tasks only
  const subCounts: Record<string, { total: number; done: number }> = {}
  const { data: subs } = await ctx.admin.from('tasks').select('parent_task_id, status').in('parent_task_id', ids)
  ;(subs || []).forEach((sub: any) => {
    const c = subCounts[sub.parent_task_id] || (subCounts[sub.parent_task_id] = { total: 0, done: 0 })
    c.total += 1
    if (sub.status === 'done') c.done += 1
  })

  // Everyone on each task, my own part, and the overall progress (shared tasks)
  const assigneesByTask = await listAssignees(ctx.admin, ids)
  const list = ids.map((id) => byId.get(id)).filter(Boolean).map((r: any) => ({
    ...r,
    assignees: assigneesByTask.get(r.id) || [],
    my_part: (assigneesByTask.get(r.id) || []).find((a) => a.user_id === me) || null,
    assignee_summary: summarize(assigneesByTask.get(r.id) || []),
    status: normalizeStatus(r.status),
    project: Array.isArray(r.projects) ? r.projects[0] : r.projects,
    projects: undefined,
    subtasks: subCounts[r.id] || { total: 0, done: 0 },
  }))
  return ok(list, 200, meta)
})
