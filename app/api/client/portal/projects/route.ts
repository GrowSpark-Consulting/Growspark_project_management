import { api } from '@/lib/api/context'
import { NextResponse } from 'next/server'
import { getClientProjects } from '@/lib/client-portal-service'
import { clientAccountId, progressFor } from '@/lib/client-access'

// GET /api/client/portal/projects - shared projects of the client's account (whitelisted fields)
export const GET = api(async (_request, ctx) => {
  clientAccountId(ctx)
  const projects = await getClientProjects(ctx.userId)
  const progress = await progressFor(ctx.admin, projects.map((p) => p.id))
  return NextResponse.json({
    success: true,
    projects: projects.map((p) => ({ ...p, progress_percent: progress[p.id] ?? 0 })),
  })
}, 'client')
