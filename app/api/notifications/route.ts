import { z } from 'zod'
import { api, ok, readJson, check } from '@/lib/api/context'

// GET /api/notifications?unread=1&limit=30 - my notifications (internal users and clients)
export const GET = api(async (request, ctx) => {
  const sp = new URL(request.url).searchParams
  const limit = Math.min(200, Math.max(1, Number(sp.get('limit')) || 30))
  let query = ctx.admin.from('notifications').select('id, title, message, type, read, link, project_id, created_at')
    .eq('user_id', ctx.userId).order('created_at', { ascending: false }).limit(limit)
  if (sp.get('unread') === '1') query = query.eq('read', false)
  const [{ data }, { count }] = await Promise.all([
    query,
    ctx.admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId).eq('read', false),
  ])
  return ok(data || [], 200, { unread: count || 0 })
}, 'any')

// POST /api/notifications { ids?: uuid[] } - mark read (all when ids omitted)
export const POST = api(async (request, ctx) => {
  const body = await readJson(request, z.object({ ids: z.array(z.string().uuid()).max(500).optional() }))
  let query = ctx.admin.from('notifications').update({ read: true }).eq('user_id', ctx.userId).eq('read', false)
  if (body.ids?.length) query = query.in('id', body.ids)
  check(await query)
  return ok({ updated: true })
}, 'any')
