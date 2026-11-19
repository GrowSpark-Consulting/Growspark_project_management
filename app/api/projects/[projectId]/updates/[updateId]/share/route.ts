import { z } from 'zod'
import { api, readJson, requireProject, ok, check, HttpError, assertUuid } from '@/lib/api/context'
import { notify, getProjectClientIds } from '@/lib/notify'

// PATCH /api/projects/[projectId]/updates/[updateId]/share { client_visible } - project managers
export const PATCH = api<{ projectId: string; updateId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({ client_visible: z.boolean() }))
  const access = await requireProject(ctx, params.projectId, 'view')
  if (!access.canManage) throw new HttpError(403, 'Only a project manager can share updates with the client')
  assertUuid(params.updateId, 'update ID')
  const { data: update } = await ctx.admin.from('project_updates').select('*').eq('id', params.updateId).maybeSingle()
  if (!update || update.project_id !== params.projectId) throw new HttpError(404, 'Update not found')
  const updated = check(await ctx.admin.from('project_updates').update({ client_visible: body.client_visible }).eq('id', update.id).select('*').single())
  if (body.client_visible && !update.client_visible) {
    await notify(ctx.admin, await getProjectClientIds(ctx.admin, params.projectId), {
      type: 'project_update', title: `Update on ${access.project.name}`,
      message: update.content.slice(0, 160), link: `/client-portal/projects/${params.projectId}?tab=discussion`, projectId: params.projectId,
    })
  }
  return ok(updated)
})
