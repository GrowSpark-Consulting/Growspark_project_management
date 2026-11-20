import { NextResponse } from 'next/server'
import { api } from '@/lib/api/context'
import { isApproved, requestApproval } from '@/lib/user-approval-server'

// GET /api/users/approval-status - is the signed-in user approved (has a role)?
export const GET = api(async (_request, ctx) => {
  return NextResponse.json({ approved: await isApproved(ctx.admin, ctx.userId) })
}, 'any')

// POST /api/users/approval-status - ask the administrators to look at my account
export const POST = api(async (_request, ctx) => {
  await requestApproval(ctx.admin, ctx.userId, ctx.user?.name || ctx.user?.email || 'A new user')
  return NextResponse.json({ success: true })
}, 'any')
