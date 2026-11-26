import { api, requireProject, ok, HttpError } from '@/lib/api/context'
import { readUpload, storeProjectFile } from '@/lib/files'
import { readCursor, applyCursor, cursorPage } from '@/lib/pagination'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/projects/[projectId]/files?taskId=&limit=&cursor= - newest first. With limit/cursor: one chunk,
// meta.nextCursor / meta.hasMore for the next ("Load more"); without: every file (as before).
export const GET = api<{ projectId: string }>(async (request, ctx, params) => {
  await requireProject(ctx, params.projectId, 'view')
  const sp = new URL(request.url).searchParams
  const taskId = sp.get('taskId')
  const chunked = sp.has('limit') || sp.has('cursor')
  const page = readCursor(sp)
  let query = ctx.admin.from('project_files')
    .select('id, task_id, file_name, mime_type, size_bytes, client_visible, uploaded_by, created_at')
    .eq('project_id', params.projectId)
  if (taskId) query = query.eq('task_id', taskId)
  const result = chunked ? await applyCursor(query, page) : await query.order('created_at', { ascending: false })
  const { rows: data, cursor } = chunked ? cursorPage(result.data || [], page) : { rows: result.data || [], cursor: null }
  const ids = Array.from(new Set((data || []).map((f: any) => f.uploaded_by).filter(Boolean))) as string[]
  const { data: people } = ids.length ? await ctx.admin.from('user_profiles').select('id, name, is_client').in('id', ids) : { data: [] }
  const byId: Record<string, any> = {}
  ;(people || []).forEach((p: any) => { byId[p.id] = p })
  const list = (data || []).map((f: any) => ({ ...f, uploader: byId[f.uploaded_by] ? { name: byId[f.uploaded_by].name, is_client: byId[f.uploaded_by].is_client } : null }))
  return cursor ? ok(list, 200, { nextCursor: cursor.nextCursor, hasMore: cursor.hasMore }) : ok(list)
})

// POST /api/projects/[projectId]/files (multipart: file, taskId?)
export const POST = api<{ projectId: string }>(async (request, ctx, params) => {
  await requireProject(ctx, params.projectId, 'contribute', { allowComplete: true })
  const { file, fields } = await readUpload(request)
  const taskId = (fields.get('taskId') as string | null) || null
  if (taskId) {
    const { data: task } = await ctx.admin.from('tasks').select('project_id').eq('id', taskId).maybeSingle()
    if (!task || task.project_id !== params.projectId) throw new HttpError(400, 'Task is not in this project')
  }
  const row = await storeProjectFile(ctx.admin, { projectId: params.projectId, taskId, file, uploadedBy: ctx.userId })
  return ok(row, 201)
})
