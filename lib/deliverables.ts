import { z } from 'zod'
import { HttpError, assertUuid, type ApiCtx } from '@/lib/api/context'

export const deliverableSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  description: z.string().max(5000).optional().nullable(),
  task_id: z.string().uuid().optional().nullable(),
  file_id: z.string().uuid().optional().nullable(),
  file_url: z.string().url('Link must be a valid URL').max(2000).optional().nullable().or(z.literal('')),
})

export async function loadDeliverable(ctx: ApiCtx, id: string) {
  assertUuid(id, 'deliverable ID')
  const { data } = await ctx.admin.from('deliverables').select('*').eq('id', id).maybeSingle()
  if (!data) throw new HttpError(404, 'Deliverable not found')
  return data
}
