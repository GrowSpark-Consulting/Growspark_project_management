import { z } from 'zod'
import { api, readJson, ok, check, HttpError } from '@/lib/api/context'

// GET /api/project-templates
export const GET = api(async (_request, ctx) => {
  const { data } = await ctx.admin
    .from('project_templates')
    .select('id, name, description, blueprint, default_workflow_template_id, created_by, created_at, updated_at')
    .order('name')
  return ok((data || []).map((t: { blueprint: { tasks?: unknown[]; milestones?: unknown[] } } & Record<string, unknown>) => ({
    ...t,
    task_count: t.blueprint?.tasks?.length || 0,
    milestone_count: t.blueprint?.milestones?.length || 0,
  })))
})

// POST /api/project-templates { name, description?, blueprint? }
export const POST = api(async (request, ctx) => {
  if (!ctx.has('manage_projects') && !ctx.has('manage_all_projects')) throw new HttpError(403, 'You need manage_projects to create templates')
  const body = await readJson(request, z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional().nullable(),
    blueprint: z.object({
      tasks: z.array(z.any()).max(500).default([]),
      milestones: z.array(z.any()).max(200).default([]),
      dependencies: z.array(z.any()).max(1000).default([]),
    }).optional(),
    default_workflow_template_id: z.string().uuid().optional().nullable(),
  }))
  const row = check(await ctx.admin.from('project_templates').insert({
    name: body.name,
    description: body.description || null,
    blueprint: body.blueprint || { tasks: [], milestones: [], dependencies: [] },
    default_workflow_template_id: body.default_workflow_template_id || null,
    created_by: ctx.userId,
  }).select('*').single())
  return ok(row, 201)
})
