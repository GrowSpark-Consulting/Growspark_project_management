import { z } from 'zod'
import { api, readJson, ok, HttpError, check, assertUuid, requireProject, type ApiCtx } from '@/lib/api/context'
import { notify, getProjectTeamIds, getProjectClientIds } from '@/lib/notify'

async function loadMilestone(ctx: ApiCtx, id: string) {
  assertUuid(id, 'milestone ID')
  const { data } = await ctx.admin.from('milestones').select('*').eq('id', id).maybeSingle()
  if (!data || !data.project_id) throw new HttpError(404, 'Milestone not found')
  return data
}

// PATCH /api/milestones/[id]
export const PATCH = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
    color: z.string().max(20).optional(),
    status: z.enum(['pending', 'completed']).optional(),
    client_visible: z.boolean().optional(),
  }))
  const milestone = await loadMilestone(ctx, params.id)
  const access = await requireProject(ctx, milestone.project_id, 'manage', { allowComplete: true })
  const update: Record<string, unknown> = { ...body, updated_at: new Date().toISOString() }
  if (body.date) update.date = body.date.slice(0, 10)
  if (body.status === 'completed' && milestone.status !== 'completed') update.completed_at = new Date().toISOString()
  if (body.status === 'pending') update.completed_at = null
  const updated = check(await ctx.admin.from('milestones').update(update).eq('id', milestone.id).select('*').single())

  if (body.status === 'completed' && milestone.status !== 'completed') {
    const recipients = await getProjectTeamIds(ctx.admin, milestone.project_id)
    if (updated.client_visible) recipients.push(...(await getProjectClientIds(ctx.admin, milestone.project_id)))
    await notify(ctx.admin, recipients, {
      type: 'milestone_completed', title: 'Milestone completed',
      message: `"${updated.name}" was completed on ${access.project.name}`,
      link: `/projects/${milestone.project_id}`, projectId: milestone.project_id,
    }, ctx.userId)
  }
  return ok(updated)
})

// DELETE /api/milestones/[id]
export const DELETE = api<{ id: string }>(async (_request, ctx, params) => {
  const milestone = await loadMilestone(ctx, params.id)
  await requireProject(ctx, milestone.project_id, 'manage', { allowComplete: true })
  check(await ctx.admin.from('milestones').delete().eq('id', milestone.id))
  return ok({ id: milestone.id })
})
