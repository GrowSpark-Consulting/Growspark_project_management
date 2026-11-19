import { api, ok } from '@/lib/api/context'

// GET /api/me/timesheets/history - my submitted/approved/rejected weeks
export const GET = api(async (_request, ctx) => {
  const { data } = await ctx.admin
    .from('timesheets')
    .select('id, week_start_date, status, total_hours, submitted_at, reviewed_at, review_note')
    .eq('user_id', ctx.userId)
    .order('week_start_date', { ascending: false })
    .limit(52)
  return ok(data || [])
})
