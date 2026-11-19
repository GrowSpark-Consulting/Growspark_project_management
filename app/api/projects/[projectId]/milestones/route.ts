import { z } from 'zod'
import { api, readJson, requireProject, ok, check } from '@/lib/api/context'

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  description: z.string().max(2000).optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Date must be YYYY-MM-DD'),
  color: z.string().max(20).optional(),
  client_visible: z.boolean().optional(),
})

// GET /api/projects/[projectId]/milestones
export const GET = api<{ projectId: string }>(async (_request, ctx, params) => {
  await requireProject(ctx, params.projectId, 'view')
  const { data } = await ctx.admin.from('milestones').select('*').eq('project_id', params.projectId).order('date')
  return ok(data || [])
})

// POST /api/projects/[projectId]/milestones (project manager)
export const POST = api<{ projectId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, schema)
  await requireProject(ctx, params.projectId, 'manage')
  const row = check(await ctx.admin.from('milestones').insert({
    project_id: params.projectId,
    name: body.name,
    description: body.description || null,
    date: body.date.slice(0, 10),
    color: body.color || '#3b82f6',
    client_visible: body.client_visible ?? true,
    created_by: ctx.userId,
  }).select('*').single())
  return ok(row, 201)
})
