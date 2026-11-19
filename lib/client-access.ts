/**
 * Client portal access: clients only ever see shared projects of their own account,
 * through server routes that whitelist fields.
 */
import { HttpError, assertUuid, type ApiCtx } from '@/lib/api/context'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function clientAccountId(ctx: ApiCtx): string {
  const accountId = ctx.user?.client_account_id
  if (!ctx.isClient || !accountId) throw new HttpError(403, 'Client access required')
  return accountId
}

export const CLIENT_PROJECT_FIELDS = 'id, name, description, status, priority, start_date, end_date, account_id, feedback_requested_at, created_at'

export async function requireClientProject(ctx: ApiCtx, projectId: string) {
  assertUuid(projectId, 'project ID')
  const accountId = clientAccountId(ctx)
  const { data } = await ctx.admin.from('projects').select(CLIENT_PROJECT_FIELDS)
    .eq('id', projectId).eq('account_id', accountId).eq('shared_with_client', true).is('archived_at', null).maybeSingle()
  if (!data) throw new HttpError(404, 'Project not found')
  return data
}

export async function clientProjectIds(ctx: ApiCtx): Promise<string[]> {
  const accountId = clientAccountId(ctx)
  const { data } = await ctx.admin.from('projects').select('id')
    .eq('account_id', accountId).eq('shared_with_client', true).is('archived_at', null)
  return (data || []).map((p: any) => p.id)
}

/** Progress % for clients = done ÷ total top-level tasks (clients never see the tasks). */
export async function progressFor(db: any, projectIds: string[]): Promise<Record<string, number>> {
  if (!projectIds.length) return {}
  const { data } = await db.from('tasks').select('project_id, status').in('project_id', projectIds).is('parent_task_id', null)
  const acc: Record<string, { total: number; done: number }> = {}
  ;(data || []).forEach((t: any) => {
    const a = acc[t.project_id] || (acc[t.project_id] = { total: 0, done: 0 })
    a.total += 1
    if (t.status === 'done') a.done += 1
  })
  return Object.fromEntries(projectIds.map((id) => [id, acc[id]?.total ? Math.round((acc[id].done / acc[id].total) * 100) : 0]))
}

/** Client-safe deliverable shape. */
export function toClientDeliverable(d: any, fileName?: string | null) {
  return {
    id: d.id, project_id: d.project_id, name: d.name, description: d.description, status: d.status,
    version: d.version, shared_at: d.shared_at, approved_at: d.approved_at, feedback: d.feedback,
    link: d.file_url || null, file: d.file_id ? { id: d.file_id, file_name: fileName || 'Attachment' } : null,
  }
}
