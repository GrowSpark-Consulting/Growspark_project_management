import { NextResponse } from 'next/server'
import { z } from 'zod'
import { api, readJson, HttpError } from '@/lib/api/context'
import { approveUser, rejectUser, approvalStats } from '@/lib/user-approval-server'

// POST /api/users/approve { userId, action: approve | reject, roleId? }
//  approve: assigns a role (Employee unless roleId is given); reject: deactivates the account
export const POST = api(async (request, ctx) => {
  if (!ctx.has('manage_user_roles')) throw new HttpError(403, 'You cannot approve users')
  const body = await readJson(request, z.object({
    userId: z.string().uuid(),
    action: z.enum(['approve', 'reject']),
    roleId: z.string().uuid().optional().nullable(),
    reason: z.string().max(500).optional().nullable(),
  }))
  const result = body.action === 'approve'
    ? await approveUser(ctx.admin, body.userId, ctx.userId, body.roleId)
    : await rejectUser(ctx.admin, body.userId, ctx.userId)
  if (!result.ok) throw new HttpError(400, result.error || `Failed to ${body.action} user`)
  return NextResponse.json({ success: true, message: `User ${body.action}d successfully` })
})

// GET /api/users/approve - counts for the pending-users page
export const GET = api(async (_request, ctx) => {
  if (!ctx.has('manage_user_roles')) throw new HttpError(403, 'You cannot approve users')
  return NextResponse.json({ stats: await approvalStats(ctx.admin) })
})
