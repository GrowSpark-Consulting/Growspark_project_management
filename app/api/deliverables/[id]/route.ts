import { z } from 'zod'
import { api, readJson, ok, HttpError, check, requireProject } from '@/lib/api/context'
import { loadDeliverable } from '@/lib/deliverables'

// PATCH /api/deliverables/[id] - edit while draft / rejected / revised
export const PATCH = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional().nullable(),
    file_id: z.string().uuid().optional().nullable(),
    file_url: z.string().url().max(2000).optional().nullable().or(z.literal('')),
  }))
  const d = await loadDeliverable(ctx, params.id)
  const access = await requireProject(ctx, d.project_id, 'contribute')
  if (d.submitted_by !== ctx.userId && !access.canManage) throw new HttpError(403, 'Only the submitter or a project manager can edit this deliverable')
  if (!['draft', 'rejected', 'revised'].includes(d.status)) throw new HttpError(409, 'Deliverable can only be edited while in draft or after rejection')
  const update: Record<string, unknown> = { ...body, file_url: body.file_url || (body.file_url === '' ? null : d.file_url), updated_at: new Date().toISOString() }
  if (d.status === 'rejected') update.status = 'revised'
  const updated = check(await ctx.admin.from('deliverables').update(update).eq('id', d.id).select('*').single())
  return ok(updated)
})

// DELETE /api/deliverables/[id] - submitter while draft, or project manager
export const DELETE = api<{ id: string }>(async (_request, ctx, params) => {
  const d = await loadDeliverable(ctx, params.id)
  const access = await requireProject(ctx, d.project_id, 'view')
  const own = d.submitted_by === ctx.userId && d.status === 'draft'
  if (!own && !access.canManage) throw new HttpError(403, 'Only a project manager can delete this deliverable')
  check(await ctx.admin.from('deliverables').delete().eq('id', d.id))
  return ok({ id: d.id })
})
