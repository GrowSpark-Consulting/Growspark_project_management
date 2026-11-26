/**
 * Comment helpers shared by task comments, update comments and the client discussion.
 */
import { applyCursor, cursorPage, type CursorRequest } from '@/lib/pagination'
import { notify, getProjectTeamIds, getProjectManagerIds } from '@/lib/notify';
import { HttpError, check, type ApiCtx } from '@/lib/api/context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function listComments(db: any, filter: { taskId?: string; updateId?: string }) {
  let query = db.from('comments').select('id, parent_id, content, mentions, created_at, updated_at, created_by').order('created_at')
  query = filter.taskId ? query.eq('task_id', filter.taskId) : query.eq('update_id', filter.updateId)
  const { data } = await query
  return withAuthors(db, data || [])
}

/**
 * A chunk of comment threads, newest threads first: `limit` top-level comments after the cursor, with all of
 * their replies, so a thread is never split. Rows come back oldest first, ready to show; nextCursor / hasMore
 * load the older threads.
 */
export async function listCommentThreads(db: any, filter: { taskId?: string; updateId?: string }, page: CursorRequest) {
  const scope = (q: any) => (filter.taskId ? q.eq('task_id', filter.taskId) : q.eq('update_id', filter.updateId))
  const columns = 'id, parent_id, content, mentions, created_at, updated_at, created_by'
  const { data: topRows, error } = await applyCursor(scope(db.from('comments').select(columns)).is('parent_id', null), page)
  if (error) throw error
  const { rows: tops, cursor } = cursorPage(topRows || [], page)
  const topIds = tops.map((t: any) => t.id)
  const { data: replies } = topIds.length
    ? await scope(db.from('comments').select(columns)).in('parent_id', topIds).order('created_at')
    : { data: [] }
  const rows = [...tops, ...(replies || [])].sort((a: any, b: any) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  return { comments: await withAuthors(db, rows), nextCursor: cursor.nextCursor, hasMore: cursor.hasMore }
}

async function withAuthors(db: any, rows: any[]) {
  const ids = Array.from(new Set(rows.map((r: any) => r.created_by).filter(Boolean))) as string[]
  const { data: people } = ids.length
    ? await db.from('user_profiles').select('id, name, image, is_client').in('id', ids)
    : { data: [] }
  const byId: Record<string, any> = {}
  ;(people || []).forEach((p: any) => { byId[p.id] = p })
  return rows.map((r: any) => ({
    ...r,
    author: r.created_by ? { id: r.created_by, name: byId[r.created_by]?.name || 'Unknown', image: byId[r.created_by]?.image || null, is_client: !!byId[r.created_by]?.is_client } : null,
  }))
}

export async function createComment(
  ctx: ApiCtx,
  opts: { projectId: string; projectName: string; taskId?: string; updateId?: string; parentId?: string | null; content: string; mentions?: string[]; link: string; useAdmin?: boolean; notifyClients?: string[] }
) {
  // Mentions must be internal members of the project team
  let mentions: string[] = []
  if (opts.mentions?.length) {
    const team = new Set(await getProjectTeamIds(ctx.admin, opts.projectId))
    const managers = await getProjectManagerIds(ctx.admin, opts.projectId)
    managers.forEach((m) => team.add(m))
    mentions = Array.from(new Set(opts.mentions)).filter((id) => team.has(id))
    if (mentions.length !== new Set(opts.mentions).size) throw new HttpError(400, 'You can only mention members of this project team')
  }

  const db = opts.useAdmin ? ctx.admin : ctx.supabase
  const comment = check(await db.from('comments').insert({
    project_id: opts.projectId,
    task_id: opts.taskId || null,
    update_id: opts.updateId || null,
    parent_id: opts.parentId || null,
    content: opts.content,
    mentions,
    created_by: ctx.userId,
  }).select('*').single())

  const actor = ctx.user?.name || 'Someone'
  const recipients = new Set<string>()
  if (opts.taskId) {
    const { data: task } = await ctx.admin.from('tasks').select('assigned_to, created_by').eq('id', opts.taskId).maybeSingle()
    if (task?.assigned_to) recipients.add(task.assigned_to)
    if (task?.created_by) recipients.add(task.created_by)
  }
  if (opts.updateId) {
    const { data: update } = await ctx.admin.from('project_updates').select('created_by').eq('id', opts.updateId).maybeSingle()
    if (update?.created_by) recipients.add(update.created_by)
  }
  if (opts.parentId) {
    const { data: parent } = await ctx.admin.from('comments').select('created_by').eq('id', opts.parentId).maybeSingle()
    if (parent?.created_by) {
      await notify(ctx.admin, [parent.created_by], {
        type: 'comment_reply', title: 'New reply to your comment',
        message: `${actor}: ${opts.content.slice(0, 140)}`, link: opts.link, projectId: opts.projectId,
      }, ctx.userId)
      recipients.delete(parent.created_by)
    }
  }
  if (mentions.length) {
    await notify(ctx.admin, mentions, {
      type: 'mention', title: `${actor} mentioned you`,
      message: `${opts.projectName}: ${opts.content.slice(0, 140)}`, link: opts.link, projectId: opts.projectId,
    }, ctx.userId)
    mentions.forEach((m) => recipients.delete(m))
  }
  ;(opts.notifyClients || []).forEach((id) => recipients.add(id))
  await notify(ctx.admin, Array.from(recipients), {
    type: 'comment', title: 'New comment',
    message: `${actor} on ${opts.projectName}: ${opts.content.slice(0, 140)}`, link: opts.link, projectId: opts.projectId,
  }, ctx.userId)

  return comment
}
