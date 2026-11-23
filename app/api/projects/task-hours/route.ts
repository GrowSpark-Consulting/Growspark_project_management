import { api, ok, HttpError } from '@/lib/api/context';
import { isValidUUID } from '@/lib/validation-helpers';

// GET /api/projects/task-hours?projectIds=a,b: each task's project and estimated hours, so a page can
// sum the estimates per project (moved off a browser query). Runs as the signed-in user.
export const GET = api(async (request, ctx) => {
  const ids = (new URL(request.url).searchParams.get('projectIds') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length > 500) throw new HttpError(400, 'Too many projects');
  if (ids.some((id) => !isValidUUID(id))) throw new HttpError(400, 'Invalid project id');
  if (!ids.length) return ok([]);
  const { data, error } = await ctx.supabase.from('tasks').select('project_id, remaining_hours, estimated_hours').in('project_id', ids);
  if (error) throw error;
  return ok(data || []);
});
