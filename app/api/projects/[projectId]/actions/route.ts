import { z } from 'zod'
import { api, readJson, requireProject, ok, check, HttpError } from '@/lib/api/context'
import { notify, getProjectClientIds, getProjectTeamIds } from '@/lib/notify'
import { buildBlueprint } from '@/lib/project-templates'

// POST /api/projects/[projectId]/actions
//   { action: 'archive' | 'unarchive' | 'request_feedback' | 'save_as_template', message?, name?, description? }
export const POST = api<{ projectId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    action: z.enum(['archive', 'unarchive', 'request_feedback', 'save_as_template']),
    message: z.string().max(1000).optional().nullable(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
  }))
  const access = await requireProject(ctx, params.projectId, 'view')
  if (!access.canManage && !(body.action === 'save_as_template' && ctx.has('manage_projects'))) {
    throw new HttpError(403, 'Only a project manager can do this')
  }
  const project = access.project

  if (body.action === 'archive' || body.action === 'unarchive') {
    const archived_at = body.action === 'archive' ? new Date().toISOString() : null
    const updated = check(await ctx.admin.from('projects').update({ archived_at }).eq('id', project.id).select('*').single())
    await notify(ctx.admin, await getProjectTeamIds(ctx.admin, project.id), {
      type: 'project_status', title: body.action === 'archive' ? 'Project archived' : 'Project restored',
      message: `${project.name} was ${body.action === 'archive' ? 'archived' : 'restored'} by ${ctx.user?.name || 'a manager'}`,
      link: `/projects/${project.id}`, projectId: project.id,
    }, ctx.userId)
    return ok(updated)
  }

  if (body.action === 'request_feedback') {
    if (!project.shared_with_client) throw new HttpError(409, 'This project is not shared with the client')
    const clients = await getProjectClientIds(ctx.admin, project.id)
    if (clients.length === 0) throw new HttpError(409, 'No active client users on this account. Invite a client first.')
    const updated = check(await ctx.admin.from('projects').update({ feedback_requested_at: new Date().toISOString() }).eq('id', project.id).select('*').single())
    await notify(ctx.admin, clients, {
      type: 'feedback_request', title: 'Feedback requested',
      message: body.message || `Please share your feedback on ${project.name}`,
      link: `/client-portal/projects/${project.id}?tab=feedback`, projectId: project.id,
    })
    return ok(updated)
  }

  // save_as_template
  const blueprint = await buildBlueprint(ctx.admin, project)
  const template = check(await ctx.admin.from('project_templates').insert({
    name: body.name || `${project.name} template`,
    description: body.description ?? project.description ?? null,
    blueprint,
    created_by: ctx.userId,
  }).select('*').single())
  return ok(template, 201)
})
