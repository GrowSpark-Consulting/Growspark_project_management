import { z } from 'zod'
import { api, readJson, ok, check, HttpError, assertUuid, type ApiCtx } from '@/lib/api/context'

async function loadTemplate(ctx: ApiCtx, id: string) {
  assertUuid(id, 'template ID')
  const { data } = await ctx.admin.from('project_templates').select('*').eq('id', id).maybeSingle()
  if (!data) throw new HttpError(404, 'Template not found')
  if (data.created_by !== ctx.userId && !ctx.has('manage_all_projects')) throw new HttpError(403, 'Only the creator can change this template')
  return data
}

// PATCH /api/project-templates/[id]
export const PATCH = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
  }))
  const t = await loadTemplate(ctx, params.id)
  return ok(check(await ctx.admin.from('project_templates').update({ ...body, updated_at: new Date().toISOString() }).eq('id', t.id).select('*').single()))
})

// DELETE /api/project-templates/[id]
export const DELETE = api<{ id: string }>(async (_request, ctx, params) => {
  const t = await loadTemplate(ctx, params.id)
  check(await ctx.admin.from('project_templates').delete().eq('id', t.id))
  return ok({ id: t.id })
})
