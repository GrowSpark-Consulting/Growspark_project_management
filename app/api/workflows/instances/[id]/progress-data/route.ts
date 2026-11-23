import { z } from 'zod';
import { api, ok, assertUuid, HttpError } from '@/lib/api/context';
import { uuidSchema } from '@/lib/validation-schemas';
import { progressAccess, progressData } from '@/lib/workflow-progress-data';

// GET /api/workflows/instances/[id]/progress-data: the workflow progress dialog's lookups (moved off
// browser queries), run as the signed-in user, so row-level security applies.
//   view=access [&activeStepId=]                            may the user progress this step, and why not
//   view=data &projectId= [&activeStepId=] [&branchId=]     the step, its form, the next steps and people
const query = z.object({
  view: z.enum(['access', 'data']),
  activeStepId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
  branchId: z.string().max(200).optional(),
});

export const GET = api<{ id: string }>(async (request, ctx, params) => {
  const instanceId = assertUuid(params.id, 'workflow instance id');
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new HttpError(400, 'Invalid request');
  const { view, activeStepId, projectId, branchId } = parsed.data;
  if (view === 'access') return ok(await progressAccess(ctx.supabase, ctx.user, instanceId, activeStepId ?? null));
  if (!projectId) throw new HttpError(400, 'projectId is required');
  return ok(await progressData(ctx.supabase, instanceId, projectId, activeStepId ?? null, branchId ?? null));
});
