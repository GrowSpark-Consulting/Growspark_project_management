import { api, ok, HttpError } from '@/lib/api/context'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/admin/users?type=internal|client|all - user management list
// Each user carries their departments: directly added (department_members, editable here) and
// through a department role (shown, changed by changing the role).
export const GET = api(async (request, ctx) => {
  if (!ctx.isSuperadmin && !ctx.has('manage_users') && !ctx.has('manage_user_roles')) {
    throw new HttpError(403, 'You need manage_users or manage_user_roles')
  }
  const type = new URL(request.url).searchParams.get('type') || 'all'
  let query = ctx.admin.from('user_profiles')
    .select('id, name, email, phone, is_active, is_client, is_superadmin, client_account_id, deactivated_at, suspended_until, suspension_reason, created_at')
    .order('name')
  if (type === 'internal') query = query.eq('is_client', false)
  if (type === 'client') query = query.eq('is_client', true)
  const { data: users } = await query
  const ids = (users || []).map((u: any) => u.id)
  const [{ data: roles }, { data: accounts }, { data: departments }, members] = await Promise.all([
    ids.length ? ctx.admin.from('user_roles').select('user_id, roles!user_roles_role_id_fkey(name, department_id)').in('user_id', ids) : Promise.resolve({ data: [] }),
    ctx.admin.from('accounts').select('id, name'),
    ctx.admin.from('departments').select('id, name').order('name'),
    // Tolerates a database without the department_members table yet (code deployed before the migration)
    ids.length ? ctx.admin.from('department_members').select('user_id, department_id').in('user_id', ids) : Promise.resolve({ data: [] }),
  ])
  const accountName: Record<string, string> = Object.fromEntries((accounts || []).map((a: any) => [a.id, a.name]))
  const deptName: Record<string, string> = Object.fromEntries((departments || []).map((d: any) => [d.id, d.name]))
  const roleOf = (r: any) => (Array.isArray(r.roles) ? r.roles[0] : r.roles)
  return ok({
    users: (users || []).map((u: any) => {
      const mine = (roles || []).filter((r: any) => r.user_id === u.id).map(roleOf).filter(Boolean)
      const direct = ((members as any)?.data || []).filter((m: any) => m.user_id === u.id).map((m: any) => m.department_id)
      const viaRole = [...new Set(mine.map((r: any) => r.department_id).filter((d: string | null) => d && !direct.includes(d)))] as string[]
      return {
        ...u,
        account_name: u.client_account_id ? accountName[u.client_account_id] || null : null,
        roles: mine.map((r: any) => r.name).filter(Boolean),
        department_ids: direct,
        departments: direct.map((d: string) => deptName[d]).filter(Boolean),
        role_departments: viaRole.map((d) => deptName[d]).filter(Boolean),
      }
    }),
    departments: departments || [],
  })
})
