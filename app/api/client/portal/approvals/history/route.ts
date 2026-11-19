import { api, ok } from '@/lib/api/context'
import { clientProjectIds } from '@/lib/client-access'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/approvals/history - deliverable and workflow-step decisions on my account
export const GET = api(async (_request, ctx) => {
  const ids = await clientProjectIds(ctx)
  if (!ids.length) return ok([])
  const [{ data: deliverables }, { data: projects }, { data: instances }] = await Promise.all([
    ctx.admin.from('deliverables').select('id, name, status, feedback, approved_at, approved_by, project_id, version').in('project_id', ids).in('status', ['approved', 'rejected']).order('approved_at', { ascending: false }),
    ctx.admin.from('projects').select('id, name').in('id', ids),
    ctx.admin.from('workflow_instances').select('id, project_id').in('project_id', ids),
  ])
  const pn: Record<string, string> = Object.fromEntries((projects || []).map((p: any) => [p.id, p.name]))
  const instanceProject: Record<string, string> = Object.fromEntries((instances || []).map((i: any) => [i.id, i.project_id]))
  const { data: clientUsers } = await ctx.admin.from('user_profiles').select('id, name').eq('is_client', true).eq('client_account_id', ctx.user.client_account_id)
  const clientIds = (clientUsers || []).map((c: any) => c.id)
  const cn: Record<string, string> = Object.fromEntries((clientUsers || []).map((c: any) => [c.id, c.name]))
  const { data: steps } = Object.keys(instanceProject).length && clientIds.length
    ? await ctx.admin.from('workflow_history').select('id, workflow_instance_id, notes, transitioned_by, created_at').in('workflow_instance_id', Object.keys(instanceProject)).in('transitioned_by', clientIds).order('created_at', { ascending: false })
    : { data: [] }
  const rows = [
    ...(deliverables || []).map((d: any) => ({
      type: 'deliverable', id: d.id, item: `${d.name} (v${d.version || 1})`, decision: d.status, comment: d.feedback,
      decided_at: d.approved_at, decided_by: cn[d.approved_by] || 'Client', project_id: d.project_id, project_name: pn[d.project_id],
    })),
    ...(steps || []).map((s: any) => ({
      type: 'workflow_step', id: s.id, item: 'Project stage', decision: (s.notes || '').includes('rejected') ? 'rejected' : 'approved',
      comment: s.notes, decided_at: s.created_at, decided_by: cn[s.transitioned_by] || 'Client',
      project_id: instanceProject[s.workflow_instance_id], project_name: pn[instanceProject[s.workflow_instance_id]],
    })),
  ].sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)))
  return ok(rows)
}, 'client')
