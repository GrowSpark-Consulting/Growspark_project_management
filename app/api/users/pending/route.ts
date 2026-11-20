import { NextResponse } from 'next/server'
import { api, HttpError } from '@/lib/api/context'
import { listPendingUsers } from '@/lib/user-approval-server'

// GET /api/users/pending - people who signed up and are waiting for a role
export const GET = api(async (_request, ctx) => {
  if (!ctx.has('manage_user_roles')) throw new HttpError(403, 'You cannot approve users')
  const users = await listPendingUsers(ctx.admin)
  return NextResponse.json({ users, count: users.length })
})
