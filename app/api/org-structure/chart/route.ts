import { z } from 'zod';
import { uuidSchema } from '@/lib/validation-schemas';
import { api, ok, HttpError } from '@/lib/api/context';
import { organizationService } from '@/lib/organization-service';

// GET /api/org-structure/chart: the org chart's data (moved off browser queries). Runs the same
// lookups as before, as the signed-in user, so row-level security applies.
//   view=structure: departments with their roles and head counts, and the role hierarchy
//   view=hierarchy: the role hierarchy tree with totals
//   view=role-users&roleId=: the people holding one role
const query = z.object({
  view: z.enum(['structure', 'hierarchy', 'role-users']),
  roleId: uuidSchema.optional(),
});

export const GET = api(async (request, ctx) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new HttpError(400, 'Invalid org chart request');
  const { view, roleId } = parsed.data;
  if (view === 'structure') return ok(await organizationService.getOrganizationStructure(ctx.supabase));
  if (view === 'hierarchy') return ok(await organizationService.getHierarchyView(ctx.supabase));
  if (!roleId) throw new HttpError(400, 'roleId is required');
  return ok(await organizationService.getUsersByRole(roleId, ctx.supabase));
});
