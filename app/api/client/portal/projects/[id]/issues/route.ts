import { z } from 'zod'
import { api, ok, readJson, check } from '@/lib/api/context'
import { requireClientProject } from '@/lib/client-access'
import { notify, getProjectManagerIds } from '@/lib/notify'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/projects/[id]/issues - issues reported by the client (or shared with the client)
export const GET = api<{ id: string }>(async (_request, ctx, params) => {
  const project = await requireClientProject(ctx, params.id)
  const { data } = await ctx.admin.from('project_issues')
    .select('id, title, content, status, severity, created_at, resolved_at, resolution_note, created_by')
    .eq('project_id', project.id).eq('client_visible', true).order('created_at', { ascending: false })
  return ok((data || []).map((i: any) => ({ ...i, created_by: undefined, reported_by_me: i.created_by === ctx.userId })))
}, 'client')

// POST /api/client/portal/projects/[id]/issues { title, content, severity? }
export const POST = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    content: z.string().trim().min(1, 'Please describe the problem').max(5000),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  }))
  const project = await requireClientProject(ctx, params.id)
  const issue = check(await ctx.admin.from('project_issues').insert({
    project_id: project.id, title: body.title, content: body.content, severity: body.severity || 'medium',
    kind: 'issue', status: 'open', client_visible: true, created_by: ctx.userId,
  }).select('id, title, content, status, severity, created_at').single())
  await notify(ctx.admin, await getProjectManagerIds(ctx.admin, project.id), {
    type: 'client_issue', title: 'Client reported an issue',
    message: `${ctx.user?.name || 'The client'} on ${project.name}: ${body.title}`,
    link: `/projects/${project.id}`, projectId: project.id,
  })
  return ok(issue, 201)
}, 'client')
