import { z } from 'zod'
import { api, ok, readJson, check } from '@/lib/api/context'
import { readCursor, applyCursor, cursorPage } from '@/lib/pagination'

// GET /api/notifications?unread=1&limit=30&cursor= - my notifications, newest first (internal users and clients).
// Keyset pages: meta.nextCursor / meta.hasMore give the next chunk ("Load more").
export const GET = api(async (request, ctx) => {
  const sp = new URL(request.url).searchParams
  const page = readCursor(sp, 30, 200)
  let query = ctx.admin.from('notifications').select('id, title, message, type, read, link, project_id, created_at')
    .eq('user_id', ctx.userId)
  if (sp.get('unread') === '1') query = query.eq('read', false)
  const [{ data }, { count }] = await Promise.all([
    applyCursor(query, page),
    ctx.admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId).eq('read', false),
  ])
  const { rows, cursor } = cursorPage(data || [], page)
  return ok(rows, 200, { unread: count || 0, nextCursor: cursor.nextCursor, hasMore: cursor.hasMore })
}, 'any')

// POST /api/notifications { ids?: uuid[] } - mark read (all when ids omitted)
export const POST = api(async (request, ctx) => {
  const body = await readJson(request, z.object({ ids: z.array(z.string().uuid()).max(500).optional() }))
  let query = ctx.admin.from('notifications').update({ read: true }).eq('user_id', ctx.userId).eq('read', false)
  if (body.ids?.length) query = query.in('id', body.ids)
  check(await query)
  return ok({ updated: true })
}, 'any')
