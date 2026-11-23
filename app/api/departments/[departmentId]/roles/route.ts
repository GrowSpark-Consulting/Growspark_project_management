import { z } from 'zod';
import { uuidSchema } from '@/lib/validation-schemas';
import { api, ok, readJson, assertUuid, HttpError } from '@/lib/api/context';

// /api/departments/[departmentId]/roles: the department page's role dialog (moved off browser queries).
// Runs the same insert and update the browser used to run, as the signed-in user, so row-level
// security decides who may, as before.
const permissions = z.record(z.string(), z.boolean());

// POST { name, permissions }: a new role in this department
export const POST = api<{ departmentId: string }>(async (request, ctx, params) => {
  const departmentId = assertUuid(params.departmentId, 'department id');
  const body = await readJson(request, z.object({ name: z.string().trim().min(1).max(100), permissions }));
  const { data, error } = await ctx.supabase
    .from('roles')
    .insert({ name: body.name, department_id: departmentId, permissions: body.permissions })
    .select()
    .single();
  if (error) throw error;
  return ok(data, 201);
});

// PATCH { roleId, name, permissions }: rename a role of this department or change its permissions
export const PATCH = api<{ departmentId: string }>(async (request, ctx, params) => {
  const departmentId = assertUuid(params.departmentId, 'department id');
  const body = await readJson(request, z.object({ roleId: uuidSchema, name: z.string().trim().min(1).max(100), permissions }));
  const { data, error } = await ctx.supabase
    .from('roles')
    .update({ name: body.name, permissions: body.permissions })
    .eq('id', body.roleId)
    .eq('department_id', departmentId)
    .select();
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, 'Role not found');
  return ok(data[0]);
});
