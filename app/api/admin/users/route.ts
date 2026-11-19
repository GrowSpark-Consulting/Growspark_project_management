import { api, ok, HttpError } from '@/lib/api/context'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/admin/users?type=internal|client|all - user management list
export const GET = api(async (request, ctx) => {
  if (!ctx.isSuperadmin && !ctx.has('manage_users') && !ctx.has('manage_user_roles')) {
    throw new HttpError(403, 'You need manage_users or manage_user_roles')
  }
  const type = new URL(request.url).searchParams.get('type') || 'all'
  let query = ctx.admin.from('user_profiles')
    .select('id, name, email, phone, is_active, is_client, is_superadmin, client_account_id, deactivated_at, created_at')
    .order('name')
  if (type === 'internal') query = query.eq('is_client', false)
  if (type === 'client') query = query.eq('is_client', true)
  const { data: users } = await query
  const ids = (users || []).map((u: any) => u.id)
  const [{ data: roles }, { data: accounts }] = await Promise.all([
    ids.length ? ctx.admin.from('user_roles').select('user_id, roles!user_roles_role_id_fkey(name)').in('user_id', ids) : Promise.resolve({ data: [] }),
    ctx.admin.from('accounts').select('id, name'),
  ])
  const accountName: Record<string, string> = Object.fromEntries((accounts || []).map((a: any) => [a.id, a.name]))
  return ok((users || []).map((u: any) => ({
    ...u,
    account_name: u.client_account_id ? accountName[u.client_account_id] || null : null,
    roles: (roles || []).filter((r: any) => r.user_id === u.id).map((r: any) => (Array.isArray(r.roles) ? r.roles[0] : r.roles)?.name).filter(Boolean),
  })))
})
