import { api, ok, HttpError } from '@/lib/api/context';
import { isValidUUID } from '@/lib/validation-helpers';

// GET /api/me/time-options: what the log-time and clock-out dialogs offer (moved off browser queries).
// Runs as the signed-in user, so row-level security applies.
//   view=projects (default): the user's active project assignments (with project status) and the
//                            projects of tasks assigned to them
//   view=tasks&projectIds=a,b[&openOnly=true]: tasks of those projects, by name
export const GET = api(async (request, ctx) => {
  const params = new URL(request.url).searchParams;
  const db = ctx.supabase;

  if (params.get('view') === 'tasks') {
    const ids = (params.get('projectIds') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 500) throw new HttpError(400, 'Too many projects');
    if (ids.some((id) => !isValidUUID(id))) throw new HttpError(400, 'Invalid project id');
    if (!ids.length) return ok([]);
    let q = db.from('tasks').select('id, name, project_id').in('project_id', ids);
    if (params.get('openOnly') === 'true') q = q.neq('status', 'done');
    const { data, error } = await q.order('name');
    if (error) throw error;
    return ok(data || []);
  }

  const [assignments, taskProjects] = await Promise.all([
    db.from('project_assignments').select('project_id, projects(id, name, status, updated_at)').eq('user_id', ctx.userId).is('removed_at', null),
    db.from('tasks').select('project_id, projects(id, name)').eq('assigned_to', ctx.userId),
  ]);
  if (assignments.error) throw assignments.error;
  return ok({ assignments: assignments.data || [], taskProjects: taskProjects.error ? [] : taskProjects.data || [] });
});
