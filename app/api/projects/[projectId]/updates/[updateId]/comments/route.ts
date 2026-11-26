import { z } from 'zod'
import { api, readJson, requireProject, ok, HttpError, assertUuid } from '@/lib/api/context'
import { listComments, listCommentThreads, createComment } from '@/lib/comments'
import { readCursor } from '@/lib/pagination'
import { getProjectClientIds } from '@/lib/notify'

const schema = z.object({
  content: z.string().trim().min(1, 'Comment cannot be empty').max(5000),
  parent_id: z.string().uuid().optional().nullable(),
  mentions: z.array(z.string().uuid()).max(20).optional(),
})

async function getUpdate(ctx: Parameters<typeof requireProject>[0], projectId: string, updateId: string) {
  assertUuid(updateId, 'update ID')
  const { data } = await ctx.admin.from('project_updates').select('id, project_id, client_visible').eq('id', updateId).maybeSingle()
  if (!data || data.project_id !== projectId) throw new HttpError(404, 'Update not found')
  return data
}

// GET /api/projects/[projectId]/updates/[updateId]/comments
export const GET = api<{ projectId: string; updateId: string }>(async (request, ctx, params) => {
  await requireProject(ctx, params.projectId, 'view')
  const update = await getUpdate(ctx, params.projectId, params.updateId)
  // With limit/cursor: a chunk of the newest threads (meta.nextCursor / meta.hasMore); without: every comment
  const sp = new URL(request.url).searchParams
  if (sp.has('limit') || sp.has('cursor')) {
    const { comments, nextCursor, hasMore } = await listCommentThreads(ctx.admin, { updateId: update.id }, readCursor(sp))
    return ok(comments, 200, { nextCursor, hasMore })
  }
  return ok(await listComments(ctx.admin, { updateId: update.id }))
})

// POST /api/projects/[projectId]/updates/[updateId]/comments
export const POST = api<{ projectId: string; updateId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, schema)
  const access = await requireProject(ctx, params.projectId, 'contribute', { allowComplete: true })
  const update = await getUpdate(ctx, params.projectId, params.updateId)
  const comment = await createComment(ctx, {
    projectId: params.projectId,
    projectName: access.project.name,
    updateId: update.id,
    parentId: body.parent_id,
    content: body.content,
    mentions: body.mentions,
    link: `/projects/${params.projectId}`,
    notifyClients: update.client_visible ? await getProjectClientIds(ctx.admin, params.projectId) : [],
  })
  return ok(comment, 201)
})
