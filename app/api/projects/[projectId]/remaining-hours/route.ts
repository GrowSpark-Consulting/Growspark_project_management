import { z } from 'zod';
import { api, ok, readJson, assertUuid, HttpError } from '@/lib/api/context';

// PATCH /api/projects/[projectId]/remaining-hours { remaining_hours }: the project page's hours slider
// (moved off a browser query). Written as the signed-in user, so the projects table's row-level
// security decides who may change it, exactly as before.
export const PATCH = api<{ projectId: string }>(async (request, ctx, params) => {
  const projectId = assertUuid(params.projectId, 'project id');
  const body = await readJson(request, z.object({ remaining_hours: z.number().min(0).max(1_000_000) }));
  const { data, error } = await ctx.supabase
    .from('projects')
    .update({ remaining_hours: body.remaining_hours, updated_at: new Date().toISOString() })
    .eq('id', projectId)
    .select('id, remaining_hours');
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, 'Project not found');
  return ok(data[0]);
});
