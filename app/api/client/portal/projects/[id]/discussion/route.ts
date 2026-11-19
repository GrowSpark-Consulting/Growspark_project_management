import { z } from 'zod'
import { api, ok, readJson, check } from '@/lib/api/context'
import { requireClientProject } from '@/lib/client-access'
import { notify, getProjectManagerIds, getProjectTeamIds } from '@/lib/notify'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/projects/[id]/discussion - shared updates with their comments/replies
export const GET = api<{ id: string }>(async (_request, ctx, params) => {
  const project = await requireClientProject(ctx, params.id)
  const { data: updates } = await ctx.admin.from('project_updates').select('id, content, created_at, created_by')
    .eq('project_id', project.id).eq('client_visible', true).order('created_at', { ascending: false }).limit(100)
  const updateIds = (updates || []).map((u: any) => u.id)
  const { data: comments } = updateIds.length
    ? await ctx.admin.from('comments').select('id, update_id, parent_id, content, created_at, created_by').in('update_id', updateIds).order('created_at')
    : { data: [] }
  const people = new Set<string>()
  ;(updates || []).forEach((u: any) => u.created_by && people.add(u.created_by))
  ;(comments || []).forEach((c: any) => c.created_by && people.add(c.created_by))
  const { data: profiles } = people.size ? await ctx.admin.from('user_profiles').select('id, name, is_client').in('id', Array.from(people)) : { data: [] }
  const byId: Record<string, any> = Object.fromEntries((profiles || []).map((p: any) => [p.id, p]))
  const author = (id: string | null) => (id && byId[id] ? { name: byId[id].name, is_client: !!byId[id].is_client, is_me: id === ctx.userId } : { name: 'Team', is_client: false, is_me: false })
  return ok((updates || []).map((u: any) => ({
    id: u.id, content: u.content, created_at: u.created_at, author: author(u.created_by),
    comments: (comments || []).filter((c: any) => c.update_id === u.id).map((c: any) => ({ id: c.id, parent_id: c.parent_id, content: c.content, created_at: c.created_at, author: author(c.created_by) })),
  })))
}, 'client')

// POST /api/client/portal/projects/[id]/discussion { content } - client posts a message to the team
export const POST = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({ content: z.string().trim().min(1, 'Message cannot be empty').max(5000) }))
  const project = await requireClientProject(ctx, params.id)
  const update = check(await ctx.admin.from('project_updates').insert({
    project_id: project.id, content: body.content, created_by: ctx.userId, client_visible: true,
  }).select('id, content, created_at').single())
  await notify(ctx.admin, [...(await getProjectManagerIds(ctx.admin, project.id)), ...(await getProjectTeamIds(ctx.admin, project.id))], {
    type: 'client_message', title: `Message from ${ctx.user?.name || 'the client'}`,
    message: `${project.name}: ${body.content.slice(0, 140)}`, link: `/projects/${project.id}`, projectId: project.id,
  })
  return ok(update, 201)
}, 'client')
