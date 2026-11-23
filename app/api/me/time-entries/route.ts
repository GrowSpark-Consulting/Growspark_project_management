import { z } from 'zod';
import { uuidSchema } from '@/lib/validation-schemas';
import { api, ok, HttpError } from '@/lib/api/context';

// GET /api/me/time-entries: the signed-in user's own time entries, for the time-entry pages
// (moved off browser queries). Runs as the user, so row-level security applies. Dates come from the
// browser, which works them out in the user's own time zone as before.
//   view=entries (default): from, to, projectId, taskId, sort, order, offset, limit → { data, count }
//   view=filters: projects and tasks the user has logged time on
//   view=summary: weekFrom, weekTo, monthFrom, monthTo, since → the rows behind the summary cards
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const query = z.object({
  view: z.enum(['entries', 'filters', 'summary']).default('entries'),
  from: date.optional(), to: date.optional(),
  projectId: uuidSchema.optional(), taskId: uuidSchema.optional(),
  sort: z.enum(['entry_date', 'hours_logged', 'project_id']).default('entry_date'),
  order: z.enum(['asc', 'desc']).default('desc'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  weekFrom: date.optional(), weekTo: date.optional(), monthFrom: date.optional(), monthTo: date.optional(), since: date.optional(),
});

export const GET = api(async (request, ctx) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'Invalid query');
  const p = parsed.data;
  const db = ctx.supabase;
  const userId = ctx.userId;

  if (p.view === 'filters') {
    const [projects, tasks] = await Promise.all([
      db.from('time_entries').select('project_id, projects(id, name)').eq('user_id', userId).not('project_id', 'is', null),
      db.from('time_entries').select('task_id, tasks(id, name)').eq('user_id', userId).not('task_id', 'is', null),
    ]);
    if (projects.error) throw projects.error;
    if (tasks.error) throw tasks.error;
    return ok({ projects: projects.data || [], tasks: tasks.data || [] });
  }

  if (p.view === 'summary') {
    if (!p.weekFrom || !p.weekTo || !p.monthFrom || !p.monthTo || !p.since) throw new HttpError(400, 'Summary dates are required');
    const [week, month, recent, total] = await Promise.all([
      db.from('time_entries').select('hours_logged').eq('user_id', userId).gte('entry_date', p.weekFrom).lte('entry_date', p.weekTo),
      db.from('time_entries').select('hours_logged').eq('user_id', userId).gte('entry_date', p.monthFrom).lte('entry_date', p.monthTo),
      db.from('time_entries').select('hours_logged, entry_date').eq('user_id', userId).gte('entry_date', p.since),
      db.from('time_entries').select('*', { count: 'exact', head: true }).eq('user_id', userId),
    ]);
    for (const r of [week, month, recent, total]) if (r.error) throw r.error;
    return ok({ week: week.data || [], month: month.data || [], recent: recent.data || [], count: total.count || 0 });
  }

  let q = db.from('time_entries').select('*, tasks(id, name), projects(id, name)', { count: 'exact' }).eq('user_id', userId);
  if (p.from) q = q.gte('entry_date', p.from);
  if (p.to) q = q.lte('entry_date', p.to);
  if (p.projectId) q = q.eq('project_id', p.projectId);
  if (p.taskId) q = q.eq('task_id', p.taskId);
  const { data, error, count } = await q.order(p.sort, { ascending: p.order === 'asc' }).range(p.offset, p.offset + p.limit - 1);
  if (error) throw error;
  return ok(data || [], 200, { count: count || 0 });
});
