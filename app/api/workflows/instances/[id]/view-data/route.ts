import { api, ok, assertUuid, HttpError } from '@/lib/api/context';

// GET /api/workflows/instances/[id]/view-data: what the workflow progress, timeline and diagram views
// load (moved off browser queries), as the signed-in user, so row-level security applies:
//   instance         the run (with its snapshots and the template's name)
//   liveNodes/Connections  the template's nodes (by position) and connections, only for runs without a
//                    started snapshot (older runs); null when they could not be read
//   activeSteps      active and waiting steps, with the assigned person's name
//   history          the run's transitions (from, to)
export const GET = api<{ id: string }>(async (_request, ctx, params) => {
  const instanceId = assertUuid(params.id, 'workflow instance id');
  const db = ctx.supabase;
  const { data: instance, error } = await db.from('workflow_instances')
    .select('*, started_snapshot, completed_snapshot, workflow_templates(name)').eq('id', instanceId).single();
  if (error || !instance) throw new HttpError(404, 'Workflow not found');

  const hasSnapshot = !!(instance.started_snapshot?.nodes && instance.started_snapshot?.connections);
  let liveNodes: unknown[] | null = null;
  let liveConnections: unknown[] | null = null;
  if (!hasSnapshot) {
    const [nodes, connections] = await Promise.all([
      db.from('workflow_nodes').select('*').eq('workflow_template_id', instance.workflow_template_id).order('position_y'),
      db.from('workflow_connections').select('*').eq('workflow_template_id', instance.workflow_template_id),
    ]);
    liveNodes = nodes.error ? null : nodes.data || [];
    liveConnections = connections.error ? null : connections.data || [];
  }

  const [steps, history] = await Promise.all([
    db.from('workflow_active_steps')
      .select('*, assigned_user:user_profiles!workflow_active_steps_assigned_user_id_fkey(name)')
      .eq('workflow_instance_id', instanceId).in('status', ['active', 'waiting']),
    db.from('workflow_history').select('from_node_id, to_node_id').eq('workflow_instance_id', instanceId),
  ]);

  return ok({
    instance,
    liveNodes,
    liveConnections,
    activeSteps: steps.error ? null : steps.data || [],
    history: history.error ? null : history.data || [],
  });
});
