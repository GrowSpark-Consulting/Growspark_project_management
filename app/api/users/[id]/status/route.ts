import { z } from 'zod'
import { api, ok, readJson, check, HttpError, assertUuid } from '@/lib/api/context'
import { hasAccountAccessServer } from '@/lib/access-control-server'
import { clearPermissionCache } from '@/lib/permission-checker'

// POST /api/users/[id]/status { active: boolean }
//  - internal users: manage_users (or superadmin)
//  - client users:   manage_client_invites + access to the client's account
export const POST = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({ active: z.boolean() }))
  const id = assertUuid(params.id, 'user ID')
  if (id === ctx.userId) throw new HttpError(400, 'You cannot change your own account status')
  const { data: target } = await ctx.admin.from('user_profiles').select('id, name, is_client, client_account_id, is_superadmin').eq('id', id).maybeSingle()
  if (!target) throw new HttpError(404, 'User not found')
  if (target.is_superadmin && !ctx.isSuperadmin) throw new HttpError(403, 'Only a superadmin can change a superadmin account')

  let allowed = ctx.isSuperadmin || ctx.has('manage_users')
  if (!allowed && target.is_client && target.client_account_id && ctx.has('manage_client_invites')) {
    allowed = await hasAccountAccessServer(ctx.admin, ctx.userId, target.client_account_id)
  }
  if (!allowed) throw new HttpError(403, 'You cannot change this account')

  // Block / unblock sign-in (Supabase Auth ban) and record status on the profile
  const { error: authError } = await ctx.admin.auth.admin.updateUserById(id, { ban_duration: body.active ? 'none' : '876000h' })
  if (authError) throw new HttpError(500, `Could not update sign-in access: ${authError.message}`)
  const profile = check(await ctx.admin.from('user_profiles').update({
    is_active: body.active,
    deactivated_at: body.active ? null : new Date().toISOString(),
  }).eq('id', id).select('id, name, is_active, deactivated_at').single())
  clearPermissionCache(id)
  return ok(profile)
}, 'internal')
