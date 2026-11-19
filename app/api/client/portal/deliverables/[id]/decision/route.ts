import { z } from 'zod'
import { api, ok, readJson, check, HttpError, assertUuid } from '@/lib/api/context'
import { clientProjectIds, toClientDeliverable } from '@/lib/client-access'
import { notify, getProjectManagerIds, getProjectTeamIds } from '@/lib/notify'

// POST /api/client/portal/deliverables/[id]/decision { decision: approved | rejected, feedback }
export const POST = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    decision: z.enum(['approved', 'rejected']),
    feedback: z.string().max(2000).optional().nullable(),
  }))
  assertUuid(params.id, 'deliverable ID')
  const { data: d } = await ctx.admin.from('deliverables').select('*').eq('id', params.id).maybeSingle()
  const allowed = await clientProjectIds(ctx)
  if (!d || !allowed.includes(d.project_id)) throw new HttpError(404, 'Deliverable not found')
  if (d.status !== 'client_review') throw new HttpError(409, 'This deliverable is not waiting for your review')
  if (body.decision === 'rejected' && !body.feedback?.trim()) throw new HttpError(400, 'Please tell the team what needs to change')

  const now = new Date().toISOString()
  const updated = check(await ctx.admin.from('deliverables').update({
    status: body.decision, approved_by: ctx.userId, approved_at: now, feedback: body.feedback || null, updated_at: now,
  }).eq('id', d.id).eq('status', 'client_review').select('*').single())

  // History entry visible to the client and the team
  await ctx.admin.from('project_updates').insert({
    project_id: d.project_id,
    content: `${body.decision === 'approved' ? '✅ Client approved' : '❌ Client rejected'} deliverable "${d.name}" (v${d.version || 1})${body.feedback ? `: "${body.feedback}"` : ''}`,
    created_by: ctx.userId,
    client_visible: true,
  })
  const recipients = [...(await getProjectManagerIds(ctx.admin, d.project_id)), d.submitted_by, ...(await getProjectTeamIds(ctx.admin, d.project_id))]
  await notify(ctx.admin, recipients, {
    type: 'client_decision',
    title: body.decision === 'approved' ? 'Deliverable approved by client' : 'Deliverable rejected by client',
    message: `"${d.name}"${body.feedback ? `: ${body.feedback}` : ''}`,
    link: `/projects/${d.project_id}`, projectId: d.project_id,
  })
  return ok(toClientDeliverable(updated))
}, 'client')
