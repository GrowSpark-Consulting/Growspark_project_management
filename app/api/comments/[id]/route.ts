import { z } from 'zod'
import { api, readJson, ok, HttpError, check, assertUuid, getProjectAccess } from '@/lib/api/context'

async function loadComment(ctx: Parameters<typeof getProjectAccess>[0], id: string) {
  assertUuid(id, 'comment ID')
  const { data } = await ctx.admin.from('comments').select('*').eq('id', id).maybeSingle()
  if (!data) throw new HttpError(404, 'Comment not found')
  return data
}

// PATCH /api/comments/[id] { content } - author only
export const PATCH = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({ content: z.string().trim().min(1).max(5000) }))
  const comment = await loadComment(ctx, params.id)
  if (comment.created_by !== ctx.userId) throw new HttpError(403, 'You can only edit your own comments')
  const updated = check(await ctx.admin.from('comments').update({ content: body.content }).eq('id', comment.id).select('*').single())
  return ok(updated)
}, 'any')

// DELETE /api/comments/[id] - author or project manager
export const DELETE = api<{ id: string }>(async (_request, ctx, params) => {
  const comment = await loadComment(ctx, params.id)
  if (comment.created_by !== ctx.userId) {
    const access = await getProjectAccess(ctx, comment.project_id)
    if (!access?.canManage) throw new HttpError(403, 'You can only delete your own comments')
  }
  check(await ctx.admin.from('comments').delete().eq('id', comment.id))
  return ok({ id: comment.id })
}, 'any')
