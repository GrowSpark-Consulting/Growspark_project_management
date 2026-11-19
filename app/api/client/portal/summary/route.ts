import { api, ok, today } from '@/lib/api/context'
import { clientAccountId, progressFor, CLIENT_PROJECT_FIELDS } from '@/lib/client-access'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/summary - client dashboard
export const GET = api(async (_request, ctx) => {
  const accountId = clientAccountId(ctx)
  const t = today()
  const { data: projects } = await ctx.admin.from('projects').select(CLIENT_PROJECT_FIELDS)
    .eq('account_id', accountId).eq('shared_with_client', true).is('archived_at', null).order('end_date', { nullsFirst: false })
  const list = projects || []
  const ids = list.map((p: any) => p.id)
  const names: Record<string, string> = Object.fromEntries(list.map((p: any) => [p.id, p.name]))
  if (!ids.length) {
    return ok({ totals: { total: 0, active: 0, completed: 0 }, projects: [], upcomingDeliveries: [], pendingApprovals: 0, pendingDeliverables: [], feedbackRequests: [], recentUpdates: [], newDocuments: [] })
  }
  const [progress, milestones, deliverables, updates, files, instances] = await Promise.all([
    progressFor(ctx.admin, ids),
    ctx.admin.from('milestones').select('id, name, date, status, project_id').in('project_id', ids).eq('client_visible', true).eq('status', 'pending').gte('date', t).order('date').limit(10),
    ctx.admin.from('deliverables').select('id, name, status, project_id, shared_at').in('project_id', ids).in('status', ['client_review']),
    ctx.admin.from('project_updates').select('id, content, created_at, project_id').in('project_id', ids).eq('client_visible', true).order('created_at', { ascending: false }).limit(5),
    ctx.admin.from('project_files').select('id, file_name, created_at, project_id').in('project_id', ids).eq('client_visible', true).order('created_at', { ascending: false }).limit(5),
    ctx.admin.from('workflow_instances').select('project_id, current_node_id, workflow_nodes!workflow_instances_current_node_id_fkey(node_type, label, settings)').in('project_id', ids).eq('status', 'active'),
  ])
  const stepApprovals = (instances.data || []).filter((i: any) => {
    const node = Array.isArray(i.workflow_nodes) ? i.workflow_nodes[0] : i.workflow_nodes
    return node?.node_type === 'approval' && node?.settings?.client_approval
  })
  return ok({
    totals: {
      total: list.length,
      active: list.filter((p: any) => p.status !== 'complete').length,
      completed: list.filter((p: any) => p.status === 'complete').length,
    },
    projects: list.map((p: any) => ({ id: p.id, name: p.name, status: p.status, end_date: p.end_date, progress_percent: progress[p.id] ?? 0 })),
    upcomingDeliveries: [
      ...(milestones.data || []).map((m: any) => ({ type: 'milestone', id: m.id, name: m.name, date: m.date, project_id: m.project_id, project_name: names[m.project_id] })),
    ],
    pendingApprovals: (deliverables.data || []).length + stepApprovals.length,
    pendingDeliverables: (deliverables.data || []).map((d: any) => ({ ...d, project_name: names[d.project_id] })),
    pendingSteps: stepApprovals.map((i: any) => ({ project_id: i.project_id, project_name: names[i.project_id], label: (Array.isArray(i.workflow_nodes) ? i.workflow_nodes[0] : i.workflow_nodes)?.label })),
    feedbackRequests: list.filter((p: any) => p.feedback_requested_at).map((p: any) => ({ project_id: p.id, project_name: p.name, requested_at: p.feedback_requested_at })),
    recentUpdates: (updates.data || []).map((u: any) => ({ ...u, project_name: names[u.project_id] })),
    newDocuments: (files.data || []).map((f: any) => ({ ...f, project_name: names[f.project_id] })),
  })
}, 'client')
