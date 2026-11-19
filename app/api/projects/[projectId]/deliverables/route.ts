import { api, readJson, requireProject, ok, check, HttpError } from '@/lib/api/context'
import { deliverableSchema } from '@/lib/deliverables'

/* eslint-disable @typescript-eslint/no-explicit-any */

// GET /api/projects/[projectId]/deliverables
export const GET = api<{ projectId: string }>(async (_request, ctx, params) => {
  await requireProject(ctx, params.projectId, 'view')
  const { data } = await ctx.admin
    .from('deliverables')
    .select('*, file:project_files!deliverables_file_id_fkey(id, file_name)')
    .eq('project_id', params.projectId)
    .order('created_at', { ascending: false })
  const ids = new Set<string>()
  ;(data || []).forEach((d: any) => { [d.submitted_by, d.approved_by, d.shared_by].forEach((id) => id && ids.add(id)) })
  const { data: people } = ids.size ? await ctx.admin.from('user_profiles').select('id, name').in('id', Array.from(ids)) : { data: [] }
  const names: Record<string, string> = {}
  ;(people || []).forEach((p: any) => { names[p.id] = p.name })
  return ok((data || []).map((d: any) => ({
    ...d,
    file: Array.isArray(d.file) ? d.file[0] || null : d.file,
    submitted_by_name: names[d.submitted_by] || null,
    approved_by_name: names[d.approved_by] || null,
    shared_by_name: names[d.shared_by] || null,
  })))
})

// POST /api/projects/[projectId]/deliverables (team member) - created as draft
export const POST = api<{ projectId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, deliverableSchema)
  await requireProject(ctx, params.projectId, 'contribute')
  if (body.file_id) {
    const { data: file } = await ctx.admin.from('project_files').select('project_id').eq('id', body.file_id).maybeSingle()
    if (!file || file.project_id !== params.projectId) throw new HttpError(400, 'File is not in this project')
  }
  const row = check(await ctx.admin.from('deliverables').insert({
    project_id: params.projectId,
    name: body.name,
    description: body.description || null,
    task_id: body.task_id || null,
    file_id: body.file_id || null,
    file_url: body.file_url || null,
    status: 'draft',
    submitted_by: ctx.userId,
    version: 1,
  }).select('*').single())
  return ok(row, 201)
})
