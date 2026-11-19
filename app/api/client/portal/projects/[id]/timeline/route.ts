import { api, ok, today } from '@/lib/api/context'
import { requireClientProject, progressFor, toClientDeliverable } from '@/lib/client-access'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/projects/[id]/timeline - dates, milestones, stages, deliveries
export const GET = api<{ id: string }>(async (_request, ctx, params) => {
  const project = await requireClientProject(ctx, params.id)
  const db = ctx.admin
  const [progress, milestones, deliverables, instance] = await Promise.all([
    progressFor(db, [project.id]),
    db.from('milestones').select('id, name, description, date, status, completed_at').eq('project_id', project.id).eq('client_visible', true).order('date'),
    db.from('deliverables').select('*').eq('project_id', project.id).in('status', ['client_review', 'approved', 'rejected']).order('shared_at', { ascending: false }),
    db.from('workflow_instances').select('id, current_node_id, workflow_template_id, started_snapshot').eq('project_id', project.id).order('started_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  // Stages = workflow steps (labels only)
  let stages: { label: string; state: 'completed' | 'current' | 'upcoming' }[] = []
  if (instance.data) {
    const [{ data: nodes }, { data: history }] = await Promise.all([
      db.from('workflow_nodes').select('id, node_type, label, position_x').eq('workflow_template_id', instance.data.workflow_template_id).order('position_x'),
      db.from('workflow_history').select('from_node_id').eq('workflow_instance_id', instance.data.id),
    ])
    const done = new Set((history || []).map((h: any) => h.from_node_id))
    stages = (nodes || []).filter((n: any) => !['start', 'end', 'conditional'].includes(n.node_type)).map((n: any) => ({
      label: n.label,
      state: n.id === instance.data.current_node_id ? 'current' : done.has(n.id) ? 'completed' : 'upcoming',
    }))
  }
  const t = today()
  const fileIds = (deliverables.data || []).map((d: any) => d.file_id).filter(Boolean)
  const { data: files } = fileIds.length ? await db.from('project_files').select('id, file_name').in('id', fileIds) : { data: [] }
  const fileName: Record<string, string> = Object.fromEntries((files || []).map((f: any) => [f.id, f.file_name]))
  return ok({
    project: { id: project.id, name: project.name, status: project.status, start_date: project.start_date, end_date: project.end_date },
    progress_percent: progress[project.id] ?? 0,
    milestones: milestones.data || [],
    stages,
    deliverables: (deliverables.data || []).map((d: any) => toClientDeliverable(d, fileName[d.file_id])),
    upcomingDeliveries: (milestones.data || []).filter((m: any) => m.status === 'pending' && m.date >= t),
  })
}, 'client')
