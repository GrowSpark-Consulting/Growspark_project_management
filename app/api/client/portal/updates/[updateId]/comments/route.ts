import { z } from 'zod'
import { api, ok, readJson, HttpError, assertUuid } from '@/lib/api/context'
import { requireClientProject } from '@/lib/client-access'
import { createComment } from '@/lib/comments'

// POST /api/client/portal/updates/[updateId]/comments { content, parent_id? } - client comments/replies on shared updates
export const POST = api<{ updateId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    content: z.string().trim().min(1, 'Comment cannot be empty').max(5000),
    parent_id: z.string().uuid().optional().nullable(),
  }))
  assertUuid(params.updateId, 'update ID')
  const { data: update } = await ctx.admin.from('project_updates').select('id, project_id, client_visible').eq('id', params.updateId).maybeSingle()
  if (!update || !update.client_visible) throw new HttpError(404, 'Update not found')
  const project = await requireClientProject(ctx, update.project_id)
  const comment = await createComment(ctx, {
    projectId: project.id, projectName: project.name, updateId: update.id, parentId: body.parent_id,
    content: body.content, link: `/projects/${project.id}`, useAdmin: true,
  })
  return ok({ id: comment.id, content: comment.content, created_at: comment.created_at, parent_id: comment.parent_id }, 201)
}, 'client')
