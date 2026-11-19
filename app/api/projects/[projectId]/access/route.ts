import { api, ok, requireProject } from '@/lib/api/context'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/projects/[projectId]/access - what the current user can do on this project + team list
export const GET = api<{ projectId: string }>(async (_request, ctx, params) => {
  const access = await requireProject(ctx, params.projectId, 'view')
  const { data: members } = await ctx.admin.from('project_assignments').select('user_id, role_in_project').eq('project_id', params.projectId).is('removed_at', null)
  const ids = Array.from(new Set([...(members || []).map((m: any) => m.user_id), access.project.assigned_user_id, access.project.created_by].filter(Boolean))) as string[]
  const { data: people } = ids.length ? await ctx.admin.from('user_profiles').select('id, name, is_client, is_active').in('id', ids) : { data: [] }
  return ok({
    canView: access.canView,
    canContribute: access.canContribute,
    canManage: access.canManage,
    isMember: access.isMember,
    canSeeBudget: access.canManage || ctx.has('view_all_projects'),
    me: ctx.userId,
    project: {
      id: access.project.id, name: access.project.name, status: access.project.status,
      archived_at: access.project.archived_at, shared_with_client: access.project.shared_with_client,
      assigned_user_id: access.project.assigned_user_id,
      feedback_requested_at: access.project.feedback_requested_at, account_id: access.project.account_id,
    },
    team: (people || []).filter((p: any) => !p.is_client && p.is_active !== false).map((p: any) => ({
      id: p.id, name: p.name, role_in_project: (members || []).find((m: any) => m.user_id === p.id)?.role_in_project || null,
    })),
  })
})
