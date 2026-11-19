import { api, HttpError, assertUuid } from '@/lib/api/context'
import { clientProjectIds } from '@/lib/client-access'
import { signedDownload } from '@/lib/files'

// GET /api/client/portal/files/[fileId] - download a shared file (60 s signed URL)
export const GET = api<{ fileId: string }>(async (_request, ctx, params) => {
  assertUuid(params.fileId, 'file ID')
  const { data: file } = await ctx.admin.from('project_files').select('id, project_id, storage_path, file_name, client_visible').eq('id', params.fileId).maybeSingle()
  const allowed = await clientProjectIds(ctx)
  // deliverable attachments are downloadable once the deliverable is shared
  let shared = !!file?.client_visible
  if (file && !shared) {
    const { data } = await ctx.admin.from('deliverables').select('id').eq('file_id', file.id).in('status', ['client_review', 'approved', 'rejected']).limit(1)
    shared = (data?.length || 0) > 0
  }
  if (!file || !shared || !allowed.includes(file.project_id)) throw new HttpError(404, 'File not found')
  return signedDownload(ctx.admin, file)
}, 'client')
