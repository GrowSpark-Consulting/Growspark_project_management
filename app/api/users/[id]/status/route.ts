import { z } from 'zod'
import { api, ok, readJson, check, HttpError, assertUuid } from '@/lib/api/context'
import { hasAccountAccessServer } from '@/lib/access-control-server'
import { clearPermissionCache } from '@/lib/permission-checker'
import { recordAudit } from '@/lib/audit'

const FOREVER = '876000h'
const MAX_SUSPENSION_MS = 366 * 24 * 3600 * 1000

// POST /api/users/[id]/status
//   { active: boolean }                                   activate / deactivate (legacy shape)
//   { action: 'activate' | 'deactivate' }
//   { action: 'suspend', reason, until? }                 suspend, optionally until a date (max 1 year)
//  - internal users: manage_users (or superadmin)
//  - client users:   manage_client_invites + access to the client's account
export const POST = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    active: z.boolean().optional(),
    action: z.enum(['activate', 'deactivate', 'suspend']).optional(),
    reason: z.string().trim().max(500).optional(),
    until: z.string().optional().nullable(),
  }))
  const action = body.action ?? (body.active === true ? 'activate' : body.active === false ? 'deactivate' : null)
  if (!action) throw new HttpError(400, 'Choose activate, deactivate or suspend')
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

  let until: Date | null = null
  if (action === 'suspend') {
    if (!body.reason) throw new HttpError(400, 'Give a reason for the suspension')
    if (body.until) {
      until = new Date(body.until)
      if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) throw new HttpError(400, 'The end date must be in the future')
      if (until.getTime() - Date.now() > MAX_SUSPENSION_MS) throw new HttpError(400, 'Suspend for at most one year (or deactivate the account)')
    }
  }
  const active = action === 'activate'
  const banHours = until ? `${Math.ceil((until.getTime() - Date.now()) / 3600000)}h` : FOREVER

  // Block / unblock sign-in (Supabase Auth ban) and record status on the profile
  const { error: authError } = await ctx.admin.auth.admin.updateUserById(id, { ban_duration: active ? 'none' : banHours })
  if (authError) throw new HttpError(500, `Could not update sign-in access: ${authError.message}`)
  const profile = check(await ctx.admin.from('user_profiles').update({
    is_active: active,
    deactivated_at: active ? null : new Date().toISOString(),
    suspended_until: action === 'suspend' ? until?.toISOString() ?? null : null,
    suspension_reason: action === 'suspend' ? body.reason : null,
  }).eq('id', id).select('id, name, is_active, deactivated_at, suspended_until, suspension_reason').single())
  clearPermissionCache(id)
  await recordAudit(ctx.admin, { actorId: ctx.userId, action: `user_${action}`, entityType: 'user', entityId: id, details: { reason: body.reason ?? null, until: until?.toISOString() ?? null } })
  return ok(profile)
}, 'internal')
