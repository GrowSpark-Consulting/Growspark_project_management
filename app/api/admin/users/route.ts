import { api, ok, HttpError } from '@/lib/api/context'
import { wantsPage, readPage, pageInfo, searchTerm } from '@/lib/pagination'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/admin/users?type=internal|client|all - user management list
// With page/pageSize (20, 50, 100): one page of users (by name) plus `pagination`; q searches name, email and
// client account name; inactive=0 hides deactivated users. Roles, departments and accounts are loaded for the
// page's users only. Without page/pageSize: every user (as before).
// Each user carries their departments: directly added (department_members, editable here) and
// through a department role (shown, changed by changing the role).
export const GET = api(async (request, ctx) => {
  if (!ctx.isSuperadmin && !ctx.has('manage_users') && !ctx.has('manage_user_roles')) {
    throw new HttpError(403, 'You need manage_users or manage_user_roles')
  }
  const sp = new URL(request.url).searchParams
  const type = sp.get('type') || 'all'
  const paged = wantsPage(sp)
  const pageRequest = readPage(sp)
  let query = ctx.admin.from('user_profiles')
    .select('id, name, email, phone, is_active, is_client, is_superadmin, client_account_id, deactivated_at, suspended_until, suspension_reason, created_at', paged ? { count: 'exact' } : undefined)
    .order('name')
    .order('id')
  if (type === 'internal') query = query.eq('is_client', false)
  if (type === 'client') query = query.eq('is_client', true)
  if (paged) {
    if (sp.get('inactive') === '0') query = query.neq('is_active', false)
    const q = searchTerm(sp)
    if (q) {
      // Clients are also found by the name of their account
      const { data: accountMatches } = await ctx.admin.from('accounts').select('id').ilike('name', `*${q}*`)
      const accountIds = (accountMatches || []).map((a: any) => a.id)
      query = query.or(`name.ilike.*${q}*,email.ilike.*${q}*${accountIds.length ? `,client_account_id.in.(${accountIds.join(',')})` : ''}`)
    }
  }
  const { data: users, count } = paged ? await query.range(pageRequest.from, pageRequest.to) : await query
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
  }, 200, paged ? { pagination: pageInfo(pageRequest, count || 0) } : undefined)
})
