import { api, ok, HttpError } from '@/lib/api/context';
import { isValidUUID } from '@/lib/validation-helpers';

// GET /api/workflows/active-instances?projectIds=a,b: active workflow runs of these projects, with the
// current step's label. Runs as the signed-in user, so row-level security decides what is returned.
// Used by the inbox, the project sections and the department overview (moved off browser queries).
export const GET = api(async (request, ctx) => {
  const ids = (new URL(request.url).searchParams.get('projectIds') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length > 500) throw new HttpError(400, 'Too many projects');
  if (ids.some((id) => !isValidUUID(id))) throw new HttpError(400, 'Invalid project id');
  if (!ids.length) return ok([]);
  const { data, error } = await ctx.supabase
    .from('workflow_instances')
    .select(`
      project_id,
      current_node_id,
      started_snapshot,
      workflow_nodes:workflow_nodes!workflow_instances_current_node_id_fkey (
        label
      )
    `)
    .in('project_id', ids)
    .eq('status', 'active');
  if (error) throw error;
  return ok(data || []);
});
