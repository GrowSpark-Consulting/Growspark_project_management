import { z } from 'zod';
import { api, ok, readJson, assertUuid, HttpError } from '@/lib/api/context';
import { checkDemoModeForDestructiveAction } from '@/lib/api-demo-guard';

// /api/departments/[departmentId]: the department admin tabs and delete dialog (moved off browser
// queries). Each runs the query the browser used to run, as the signed-in user, so row-level security
// decides who may read, change or delete, as before.

// GET: the department's roles (with head counts), everyone's role assignments, and the department
export const GET = api<{ departmentId: string }>(async (_request, ctx, params) => {
  const departmentId = assertUuid(params.departmentId, 'department id');
  const db = ctx.supabase;
  const [roles, users, department] = await Promise.all([
    db.from('roles').select('*, user_roles!user_roles_role_id_fkey(count)').eq('department_id', departmentId).order('name'),
    db.from('user_profiles').select(`
      id, name, email, image,
      user_roles!user_roles_user_id_fkey (
        id, role_id,
        roles!user_roles_role_id_fkey ( id, name, department_id )
      )
    `).order('name'),
    db.from('departments').select('*').eq('id', departmentId).maybeSingle(),
  ]);
  return ok({
    roles: roles.error ? null : roles.data || [],
    users: users.error ? null : users.data || [],
    department: department.error ? null : department.data,
  });
});

// PATCH: name and description
export const PATCH = api<{ departmentId: string }>(async (request, ctx, params) => {
  const departmentId = assertUuid(params.departmentId, 'department id');
  const body = await readJson(request, z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).optional().nullable(),
  }));
  const { data, error } = await ctx.supabase
    .from('departments')
    .update({ name: body.name, description: body.description ?? null, updated_at: new Date().toISOString() })
    .eq('id', departmentId)
    .select();
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, 'Department not found');
  return ok(data[0]);
});

// DELETE
export const DELETE = api<{ departmentId: string }>(async (_request, ctx, params) => {
  const departmentId = assertUuid(params.departmentId, 'department id');
  const blocked = checkDemoModeForDestructiveAction('delete_department');
  if (blocked) return blocked;
  const { data, error } = await ctx.supabase.from('departments').delete().eq('id', departmentId).select('id');
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, 'Department not found');
  return ok({ id: departmentId });
});
