import { api, ok } from '@/lib/api/context'
import { requireClientProject } from '@/lib/client-access'
import { readUpload, storeProjectFile } from '@/lib/files'
import { notify, getProjectManagerIds } from '@/lib/notify'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/projects/[id]/files - shared documents
export const GET = api<{ id: string }>(async (_request, ctx, params) => {
  const project = await requireClientProject(ctx, params.id)
  const { data } = await ctx.admin.from('project_files').select('id, file_name, mime_type, size_bytes, created_at, uploaded_by')
    .eq('project_id', project.id).eq('client_visible', true).order('created_at', { ascending: false })
  return ok((data || []).map((f: any) => ({ id: f.id, file_name: f.file_name, mime_type: f.mime_type, size_bytes: f.size_bytes, created_at: f.created_at, uploaded_by_me: f.uploaded_by === ctx.userId })))
}, 'client')

// POST /api/client/portal/projects/[id]/files (multipart: file) - upload a requested document
export const POST = api<{ id: string }>(async (request, ctx, params) => {
  const project = await requireClientProject(ctx, params.id)
  const { file } = await readUpload(request)
  const row = await storeProjectFile(ctx.admin, { projectId: project.id, file, uploadedBy: ctx.userId, clientVisible: true })
  await notify(ctx.admin, await getProjectManagerIds(ctx.admin, project.id), {
    type: 'client_upload', title: 'Client uploaded a document',
    message: `${ctx.user?.name || 'The client'} uploaded "${row.file_name}" to ${project.name}`,
    link: `/projects/${project.id}`, projectId: project.id,
  })
  return ok({ id: row.id, file_name: row.file_name, size_bytes: row.size_bytes, created_at: row.created_at, uploaded_by_me: true }, 201)
}, 'client')
