import { NextResponse } from 'next/server'
import { api, HttpError } from '@/lib/api/context'
import { getClientProjectById } from '@/lib/client-portal-service'
import { clientAccountId, progressFor } from '@/lib/client-access'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/projects/[id] - project detail for clients (whitelisted fields only)
export const GET = api<{ id: string }>(async (_request, ctx, params) => {
  clientAccountId(ctx)
  const project = await getClientProjectById(ctx.userId, params.id)
  if (!project) throw new HttpError(404, 'Project not found or access denied')
  const db = ctx.admin

  const [teamResult, updatesResult, workflowNodesResult, workflowHistoryResult, progress] = await Promise.all([
    db.from('project_assignments').select('role_in_project, user_id').eq('project_id', params.id).is('removed_at', null),
    db.from('project_updates').select('id, content, created_at, created_by').eq('project_id', params.id).eq('client_visible', true)
      .order('created_at', { ascending: false }).limit(50),
    project.workflow_instance?.workflow_templates?.id
      ? db.from('workflow_nodes').select('id, node_type, label, position_x, position_y, settings')
          .eq('workflow_template_id', project.workflow_instance.workflow_templates.id).order('position_x', { ascending: true })
      : Promise.resolve({ data: null }),
    project.workflow_instance?.id
      ? db.from('workflow_history').select('from_node_id, to_node_id, created_at').eq('workflow_instance_id', project.workflow_instance.id)
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: null }),
    progressFor(db, [params.id]),
  ])

  const people = new Set<string>()
  ;(teamResult.data || []).forEach((a: any) => people.add(a.user_id))
  ;(updatesResult.data || []).forEach((u: any) => u.created_by && people.add(u.created_by))
  const { data: profiles } = people.size ? await db.from('user_profiles').select('id, name, image, is_client').in('id', Array.from(people)) : { data: [] }
  const byId: Record<string, any> = Object.fromEntries((profiles || []).map((p: any) => [p.id, p]))

  const completed = new Set<string>()
  ;(workflowHistoryResult.data || []).forEach((h: any) => h.from_node_id && completed.add(h.from_node_id))

  return NextResponse.json({
    success: true,
    project: { ...project, progress_percent: progress[params.id] ?? 0 },
    // team: name + role only (never email / internal profile fields)
    team: (teamResult.data || []).filter((a: any) => byId[a.user_id] && !byId[a.user_id].is_client).map((a: any, i: number) => ({
      id: `member-${i}`, role_in_project: a.role_in_project, user: { id: `member-${i}`, name: byId[a.user_id].name, image: byId[a.user_id].image },
    })),
    updates: (updatesResult.data || []).map((u: any) => ({
      id: u.id, content: u.content, created_at: u.created_at,
      author: u.created_by && byId[u.created_by] ? { id: u.created_by, name: byId[u.created_by].name, is_client: !!byId[u.created_by].is_client } : null,
    })),
    workflow_nodes: (workflowNodesResult.data || []).map((n: any) => ({
      id: n.id, node_type: n.node_type, label: n.label, position_x: n.position_x, position_y: n.position_y,
      client_approval: !!n.settings?.client_approval,
    })),
    completed_node_ids: Array.from(completed),
  })
}, 'client')
