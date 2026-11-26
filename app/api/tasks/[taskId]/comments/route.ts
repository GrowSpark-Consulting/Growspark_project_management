import { z } from 'zod'
import { api, readJson, requireTask, ok } from '@/lib/api/context'
import { listComments, listCommentThreads, createComment } from '@/lib/comments'
import { readCursor } from '@/lib/pagination'

const schema = z.object({
  content: z.string().trim().min(1, 'Comment cannot be empty').max(5000),
  parent_id: z.string().uuid().optional().nullable(),
  mentions: z.array(z.string().uuid()).max(20).optional(),
})

// GET /api/tasks/[taskId]/comments
export const GET = api<{ taskId: string }>(async (request, ctx, params) => {
  const { task } = await requireTask(ctx, params.taskId, 'view')
  // With limit/cursor: a chunk of the newest threads (meta.nextCursor / meta.hasMore); without: every comment
  const sp = new URL(request.url).searchParams
  if (sp.has('limit') || sp.has('cursor')) {
    const { comments, nextCursor, hasMore } = await listCommentThreads(ctx.admin, { taskId: task.id }, readCursor(sp))
    return ok(comments, 200, { nextCursor, hasMore })
  }
  return ok(await listComments(ctx.admin, { taskId: task.id }))
})

// POST /api/tasks/[taskId]/comments { content, parent_id?, mentions? }
export const POST = api<{ taskId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, schema)
  const { task, access } = await requireTask(ctx, params.taskId, 'contribute')
  const comment = await createComment(ctx, {
    projectId: task.project_id,
    projectName: access.project.name,
    taskId: task.id,
    parentId: body.parent_id,
    content: body.content,
    mentions: body.mentions,
    link: `/projects/${task.project_id}?task=${task.id}`,
  })
  return ok(comment, 201)
})
