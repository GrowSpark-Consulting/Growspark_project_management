import { api, ok } from '@/lib/api/context'
import { clientProjectIds } from '@/lib/client-access'

/* eslint-disable @typescript-eslint/no-explicit-any */
// GET /api/client/portal/feedback - my feedback history
export const GET = api(async (_request, ctx) => {
  const ids = await clientProjectIds(ctx)
  const { data } = await ctx.admin.from('client_feedback')
    .select('id, project_id, satisfaction_score, what_went_well, what_needs_improvement, submitted_at')
    .eq('client_user_id', ctx.userId).order('submitted_at', { ascending: false })
  const { data: projects } = ids.length ? await ctx.admin.from('projects').select('id, name').in('id', ids) : { data: [] }
  const pn: Record<string, string> = Object.fromEntries((projects || []).map((p: any) => [p.id, p.name]))
  return ok((data || []).map((f: any) => ({ ...f, project_name: pn[f.project_id] || 'Project' })))
}, 'client')
