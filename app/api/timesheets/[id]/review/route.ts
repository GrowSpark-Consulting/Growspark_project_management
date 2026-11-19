import { z } from 'zod'
import { api, readJson, ok, check, HttpError, assertUuid, getScope } from '@/lib/api/context'
import { notify } from '@/lib/notify'

/* eslint-disable @typescript-eslint/no-explicit-any */
// POST /api/timesheets/[id]/review { decision: approve | reject, note? }
export const POST = api<{ id: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(2000).optional().nullable(),
  }))
  assertUuid(params.id, 'timesheet ID')
  const { data: sheet } = await ctx.admin.from('timesheets').select('*').eq('id', params.id).maybeSingle()
  if (!sheet) throw new HttpError(404, 'Timesheet not found')
  if (sheet.user_id === ctx.userId) throw new HttpError(403, 'You cannot approve your own timesheet')
  if (sheet.status !== 'submitted') throw new HttpError(409, `Timesheet is ${sheet.status}, not submitted`)
  if (body.decision === 'reject' && !body.note?.trim()) throw new HttpError(400, 'Please give a reason for rejecting')

  // Approver: org-wide, or approve_timesheets + leads a project this person logged time on
  let allowed = ctx.isSuperadmin || ctx.has('view_all_time_entries')
  if (!allowed && ctx.has('approve_timesheets')) {
    const scope = await getScope(ctx)
    if (scope.projectIds.length) {
      const { data } = await ctx.admin.from('time_entries').select('id').eq('user_id', sheet.user_id).in('project_id', scope.projectIds).limit(1)
      allowed = (data?.length || 0) > 0
    }
  }
  if (!allowed) throw new HttpError(403, 'You cannot approve this timesheet')

  const updated = check(await ctx.admin.from('timesheets').update({
    status: body.decision === 'approve' ? 'approved' : 'rejected',
    reviewed_by: ctx.userId, reviewed_at: new Date().toISOString(),
    review_note: body.note || null, updated_at: new Date().toISOString(),
  }).eq('id', sheet.id).select('*').single())

  await notify(ctx.admin, [sheet.user_id], {
    type: body.decision === 'approve' ? 'timesheet_approved' : 'timesheet_rejected',
    title: body.decision === 'approve' ? 'Timesheet approved' : 'Timesheet rejected',
    message: `Week of ${sheet.week_start_date}: ${body.decision === 'approve' ? 'approved' : 'rejected'} by ${ctx.user?.name || 'your manager'}${body.note ? ` — ${body.note}` : ''}`,
    link: `/timesheets?week=${sheet.week_start_date}`,
  })
  return ok(updated)
})
