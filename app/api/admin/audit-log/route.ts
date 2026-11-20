import { api, ok, HttpError } from '@/lib/api/context'

// GET /api/admin/audit-log?limit=100&projectId=&actorId= - superadmin only
export const GET = api(async (request, ctx) => {
  if (!ctx.isSuperadmin) throw new HttpError(403, 'Only a superadmin can read the audit log')
  const sp = new URL(request.url).searchParams
  const limit = Math.min(Math.max(parseInt(sp.get('limit') || '100', 10) || 100, 1), 500)
  let q = ctx.admin.from('audit_log').select('id, actor_id, action, entity_type, entity_id, project_id, details, created_at').order('created_at', { ascending: false }).limit(limit)
  if (sp.get('projectId')) q = q.eq('project_id', sp.get('projectId'))
  if (sp.get('actorId')) q = q.eq('actor_id', sp.get('actorId'))
  const { data, error } = await q
  if (error) throw error
  const ids = Array.from(new Set((data || []).map((r: any) => r.actor_id).filter(Boolean)))
  const { data: people } = ids.length ? await ctx.admin.from('user_profiles').select('id, name').in('id', ids) : { data: [] }
  const names: Record<string, string> = Object.fromEntries((people || []).map((p: any) => [p.id, p.name]))
  return ok((data || []).map((r: any) => ({ ...r, actor_name: names[r.actor_id] || null })))
})
