import { api, ok } from '@/lib/api/context'
import { clientProjectIds, toClientDeliverable } from '@/lib/client-access'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/deliverables?status=client_review|approved|rejected&projectId=
export const GET = api(async (request, ctx) => {
  const sp = new URL(request.url).searchParams
  let ids = await clientProjectIds(ctx)
  const projectId = sp.get('projectId')
  if (projectId) ids = ids.filter((id) => id === projectId)
  if (!ids.length) return ok([])
  const status = sp.get('status')
  const statuses = status && ['client_review', 'approved', 'rejected'].includes(status) ? [status] : ['client_review', 'approved', 'rejected']
  const { data } = await ctx.admin.from('deliverables').select('*').in('project_id', ids).in('status', statuses).order('shared_at', { ascending: false })
  const [{ data: projects }, { data: files }] = await Promise.all([
    ctx.admin.from('projects').select('id, name').in('id', ids),
    ctx.admin.from('project_files').select('id, file_name').in('id', (data || []).map((d: any) => d.file_id).filter(Boolean).concat(['00000000-0000-0000-0000-000000000000'])),
  ])
  const pn: Record<string, string> = Object.fromEntries((projects || []).map((p: any) => [p.id, p.name]))
  const fn: Record<string, string> = Object.fromEntries((files || []).map((f: any) => [f.id, f.file_name]))
  return ok((data || []).map((d: any) => ({ ...toClientDeliverable(d, fn[d.file_id]), project_name: pn[d.project_id] })))
}, 'client')
