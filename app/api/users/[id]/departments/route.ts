import { z } from 'zod'
import { api, ok, readJson, check, HttpError, assertUuid } from '@/lib/api/context'
import { recordAudit } from '@/lib/audit'
import { clearPermissionCache } from '@/lib/permission-checker'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Who may set people's departments: superadmin, or anyone who manages users, user roles or departments
const canManage = (ctx: any) => ctx.isSuperadmin || ctx.has('manage_users') || ctx.has('manage_user_roles') || ctx.has('manage_departments')

// GET /api/users/[id]/departments - the departments this person was added to directly
export const GET = api<{ id: string }>(async (_request, ctx, params) => {
  if (!canManage(ctx)) throw new HttpError(403, "You can't manage departments")
  const id = assertUuid(params.id, 'user ID')
  const { data } = await ctx.admin.from('department_members').select('department_id').eq('user_id', id)
  return ok({ departmentIds: (data || []).map((m: any) => m.department_id) })
})

// PUT /api/users/[id]/departments { departmentIds } - replace the person's direct department memberships.
// Departments they are in through a department role are not affected.
export const PUT = api<{ id: string }>(async (request, ctx, params) => {
  if (!canManage(ctx)) throw new HttpError(403, "You can't manage departments")
  const id = assertUuid(params.id, 'user ID')
  const body = await readJson(request, z.object({ departmentIds: z.array(z.string().uuid()).max(50) }))
  const wanted = Array.from(new Set(body.departmentIds))

  const { data: target } = await ctx.admin.from('user_profiles').select('id, name, is_client, is_superadmin').eq('id', id).maybeSingle()
  if (!target) throw new HttpError(404, 'User not found')
  if (target.is_client) throw new HttpError(400, 'Clients belong to their company account, not to departments')
  if (target.is_superadmin && !ctx.isSuperadmin) throw new HttpError(403, "Only a superadmin can change a superadmin's departments")

  if (wanted.length) {
    const { data: found } = await ctx.admin.from('departments').select('id').in('id', wanted)
    if ((found || []).length !== wanted.length) throw new HttpError(400, 'One or more departments do not exist')
  }

  const { data: current } = await ctx.admin.from('department_members').select('department_id').eq('user_id', id)
  const have = new Set<string>((current || []).map((m: any) => m.department_id as string))
  const add = wanted.filter((d) => !have.has(d))
  const remove = [...have].filter((d) => !wanted.includes(d))

  if (remove.length) check(await ctx.admin.from('department_members').delete().eq('user_id', id).in('department_id', remove))
  if (add.length) check(await ctx.admin.from('department_members').insert(add.map((department_id) => ({ department_id, user_id: id, added_by: ctx.userId }))))

  if (add.length || remove.length) {
    clearPermissionCache()
    await recordAudit(ctx.admin, { actorId: ctx.userId, action: 'user_departments_changed', entityType: 'user', entityId: id, details: { added: add, removed: remove } })
  }
  return ok({ departmentIds: wanted, added: add.length, removed: remove.length })
})
