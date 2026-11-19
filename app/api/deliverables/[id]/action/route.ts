import { z } from 'zod'
import { api, readJson, ok, HttpError, check, requireProject } from '@/lib/api/context'
import { notify, getProjectManagerIds, getProjectClientIds } from '@/lib/notify'
import { loadDeliverable } from '@/lib/deliverables'

// POST /api/deliverables/[id]/action { action: submit | share | return, note? }
//  submit: team member  draft/revised/rejected → pending_review
//  share:  manager      pending_review → client_review (client is notified)
//  return: manager      pending_review/client_review → draft
export const POST = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    action: z.enum(['submit', 'share', 'return']),
    note: z.string().max(2000).optional().nullable(),
  }))
  const d = await loadDeliverable(ctx, params.id)
  const access = await requireProject(ctx, d.project_id, 'contribute', { allowComplete: true })
  const now = new Date().toISOString()
  const actor = ctx.user?.name || 'Someone'
  let update: Record<string, unknown>

  if (body.action === 'submit') {
    if (!['draft', 'revised', 'rejected'].includes(d.status)) throw new HttpError(409, `Cannot submit a deliverable that is ${d.status.replace('_', ' ')}`)
    update = {
      status: 'pending_review', submitted_at: now, submitted_by: d.submitted_by || ctx.userId,
      version: d.status === 'draft' && !d.shared_at ? d.version || 1 : (d.version || 1) + 1,
    }
    await notify(ctx.admin, await getProjectManagerIds(ctx.admin, d.project_id), {
      type: 'deliverable_review', title: 'Deliverable ready for review',
      message: `${actor} submitted "${d.name}" on ${access.project.name}`,
      link: `/manager/approvals`, projectId: d.project_id,
    }, ctx.userId)
  } else {
    if (!access.canManage) throw new HttpError(403, 'Only a project manager can review deliverables')
    if (body.action === 'share') {
      if (d.status !== 'pending_review') throw new HttpError(409, 'Only deliverables awaiting internal review can be shared')
      if (!access.project.shared_with_client) throw new HttpError(409, 'This project is not shared with the client. Enable client sharing first.')
      update = { status: 'client_review', shared_at: now, shared_by: ctx.userId, feedback: body.note ?? d.feedback, approved_by: null, approved_at: null }
      await notify(ctx.admin, await getProjectClientIds(ctx.admin, d.project_id), {
        type: 'deliverable_shared', title: 'New deliverable to review',
        message: `"${d.name}" is ready for your review on ${access.project.name}`,
        link: `/client-portal/approvals`, projectId: d.project_id,
      })
    } else {
      if (!['pending_review', 'client_review'].includes(d.status)) throw new HttpError(409, 'Nothing to return')
      update = { status: 'draft', feedback: body.note ?? d.feedback }
      await notify(ctx.admin, [d.submitted_by], {
        type: 'deliverable_returned', title: 'Deliverable returned',
        message: `${actor} returned "${d.name}"${body.note ? `: ${body.note}` : ''}`,
        link: `/projects/${d.project_id}`, projectId: d.project_id,
      }, ctx.userId)
    }
  }

  const updated = check(await ctx.admin.from('deliverables').update({ ...update, updated_at: now }).eq('id', d.id).select('*').single())
  return ok(updated)
})
