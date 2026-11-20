import { z } from 'zod'
import { api, ok, readJson, requireProject, check } from '@/lib/api/context'
import { boardColumnsSchema, normalizeBoardColumns } from '@/lib/board-columns'

// GET /api/projects/[projectId]/board - the task board columns (defaults filled in)
export const GET = api<{ projectId: string }>(async (_request, ctx, params) => {
  const access = await requireProject(ctx, params.projectId, 'view')
  return ok({ columns: normalizeBoardColumns(access.project.board_columns), customized: !!access.project.board_columns, canManage: access.canManage })
})

// PUT /api/projects/[projectId]/board { columns | reset } - project managers only
export const PUT = api<{ projectId: string }>(async (request, ctx, params) => {
  const body = await readJson(request, z.object({ columns: boardColumnsSchema.optional(), reset: z.boolean().optional() }))
  await requireProject(ctx, params.projectId, 'manage', { allowComplete: true })
  const value = body.reset || !body.columns ? null : body.columns.map((c) => ({ status: c.status, label: c.label, hidden: !!c.hidden, wip_limit: c.wip_limit ?? null }))
  check(await ctx.supabase.from('projects').update({ board_columns: value }).eq('id', params.projectId).select('id').single())
  return ok({ columns: normalizeBoardColumns(value), customized: !!value })
})
