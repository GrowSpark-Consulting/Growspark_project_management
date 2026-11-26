import { api, ok, HttpError, assertUuid } from '@/lib/api/context'
import { readCursor, applyCursor, cursorPage } from '@/lib/pagination'

// GET /api/admin/audit-log?limit=100&cursor=&projectId=&actorId= - superadmin only, newest first.
// Keyset pages: meta.nextCursor / meta.hasMore give the next chunk.
export const GET = api(async (request, ctx) => {
  if (!ctx.isSuperadmin) throw new HttpError(403, 'Only a superadmin can read the audit log')
  const sp = new URL(request.url).searchParams
  const page = readCursor(sp, 100, 500)
  let q = ctx.admin.from('audit_log').select('id, actor_id, action, entity_type, entity_id, project_id, details, created_at')
  if (sp.get('projectId')) q = q.eq('project_id', assertUuid(sp.get('projectId'), 'project ID'))
  if (sp.get('actorId')) q = q.eq('actor_id', assertUuid(sp.get('actorId'), 'actor ID'))
  const result = await applyCursor(q, page)
  if (result.error) throw result.error
  const { rows: data, cursor } = cursorPage(result.data || [], page)
  const ids = Array.from(new Set((data || []).map((r: any) => r.actor_id).filter(Boolean)))
  const { data: people } = ids.length ? await ctx.admin.from('user_profiles').select('id, name').in('id', ids) : { data: [] }
  const names: Record<string, string> = Object.fromEntries((people || []).map((p: any) => [p.id, p.name]))
  return ok((data || []).map((r: any) => ({ ...r, actor_name: names[r.actor_id] || null })), 200, { nextCursor: cursor.nextCursor, hasMore: cursor.hasMore })
})
