import { z } from 'zod'
import { api, readJson, ok, HttpError, check, assertUuid, requireProject, type ApiCtx } from '@/lib/api/context'
import { signedDownload, deleteProjectFile } from '@/lib/files'
import { notify, getProjectClientIds } from '@/lib/notify'

async function loadFile(ctx: ApiCtx, fileId: string) {
  assertUuid(fileId, 'file ID')
  const { data } = await ctx.admin.from('project_files').select('*').eq('id', fileId).maybeSingle()
  if (!data) throw new HttpError(404, 'File not found')
  return data
}

// GET /api/files/[fileId] - download (redirect to a 60 s signed URL)
export const GET = api<{ fileId: string }>(async (_request, ctx, params) => {
  const file = await loadFile(ctx, params.fileId)
  await requireProject(ctx, file.project_id, 'view')
  return signedDownload(ctx.admin, file)
})

// PATCH /api/files/[fileId] { file_name?, client_visible? }
export const PATCH = api<{ fileId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    file_name: z.string().trim().min(1).max(255).optional(),
    client_visible: z.boolean().optional(),
  }))
  const file = await loadFile(ctx, params.fileId)
  const access = await requireProject(ctx, file.project_id, 'view')
  if (body.client_visible !== undefined && !access.canManage) throw new HttpError(403, 'Only a project manager can share files with the client')
  if (body.file_name !== undefined && file.uploaded_by !== ctx.userId && !access.canManage) throw new HttpError(403, 'Only the uploader can rename this file')
  const updated = check(await ctx.admin.from('project_files').update(body).eq('id', file.id).select('*').single())
  if (body.client_visible === true && !file.client_visible) {
    await notify(ctx.admin, await getProjectClientIds(ctx.admin, file.project_id), {
      type: 'document_shared', title: 'New document shared',
      message: `"${file.file_name}" was shared on ${access.project.name}`,
      link: `/client-portal/projects/${file.project_id}?tab=documents`, projectId: file.project_id,
    })
  }
  return ok(updated)
})

// DELETE /api/files/[fileId] - uploader or project manager
export const DELETE = api<{ fileId: string }>(async (_request, ctx, params) => {
  const file = await loadFile(ctx, params.fileId)
  const access = await requireProject(ctx, file.project_id, 'view')
  if (file.uploaded_by !== ctx.userId && !access.canManage) throw new HttpError(403, 'Only the uploader or a project manager can delete this file')
  await deleteProjectFile(ctx.admin, file)
  return ok({ id: file.id })
})
