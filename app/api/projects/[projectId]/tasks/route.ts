import { api, ok, assertUuid } from '@/lib/api/context';
import { isValidUUID } from '@/lib/validation-helpers';

// GET /api/projects/[projectId]/tasks[?exclude=taskId]: the project's tasks by name (id, name, status),
// e.g. to pick a dependency. Runs as the signed-in user, so row-level security decides.
export const GET = api<{ projectId: string }>(async (request, ctx, params) => {
  const projectId = assertUuid(params.projectId, 'project id');
  const exclude = new URL(request.url).searchParams.get('exclude');
  let q = ctx.supabase.from('tasks').select('id, name, status').eq('project_id', projectId);
  if (exclude && isValidUUID(exclude)) q = q.neq('id', exclude);
  const { data, error } = await q.order('name');
  if (error) throw error;
  return ok(data || []);
});
