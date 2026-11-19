import { z } from 'zod'
import { api, readJson, ok, check, HttpError } from '@/lib/api/context'
import { applyBlueprint, type Blueprint } from '@/lib/project-templates'
import { hasAccountAccessServer } from '@/lib/access-control-server'

// POST /api/projects/from-template { template_id, name, account_id, start_date, end_date?, assigned_user_id? }
export const POST = api(async (request, ctx) => {
  const body = await readJson(request, z.object({
    template_id: z.string().uuid(),
    name: z.string().trim().min(1).max(500),
    account_id: z.string().uuid(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().nullable(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  }))
  if (!ctx.has('manage_projects') && !ctx.has('manage_all_projects')) throw new HttpError(403, 'You need manage_projects to create projects')
  if (!ctx.isSuperadmin && !ctx.has('manage_all_projects') && !ctx.has('view_all_accounts')) {
    const ok2 = await hasAccountAccessServer(ctx.admin, ctx.userId, body.account_id)
    if (!ok2) throw new HttpError(403, 'You do not have access to this account')
  }
  const { data: template } = await ctx.admin.from('project_templates').select('*').eq('id', body.template_id).maybeSingle()
  if (!template) throw new HttpError(404, 'Template not found')

  const project = check(await ctx.admin.from('projects').insert({
    name: body.name,
    description: template.description || null,
    account_id: body.account_id,
    status: 'planning',
    priority: body.priority || 'medium',
    start_date: body.start_date.slice(0, 10),
    end_date: body.end_date ? body.end_date.slice(0, 10) : null,
    created_by: ctx.userId,
    assigned_user_id: ctx.userId,
  }).select('*').single())

  await ctx.admin.from('project_assignments').insert({
    project_id: project.id, user_id: ctx.userId, role_in_project: 'owner', assigned_by: ctx.userId, source_type: 'creator',
  })
  const summary = await applyBlueprint(ctx.admin, project.id, body.start_date, template.blueprint as Blueprint, ctx.userId)
  return ok({ project, ...summary }, 201)
})
