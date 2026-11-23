import { z } from 'zod';
import { api, ok, readJson, assertUuid, HttpError } from '@/lib/api/context';
import { checkDemoModeForDestructiveAction } from '@/lib/api-demo-guard';
import { updateNewsletter, deleteNewsletter } from '@/lib/modules/newsletters/service';

const text = (field: string, max: number) =>
  z.string().max(max, `${field} is too long`).refine((s) => s.trim().length > 0, `${field} is required`);

const changes = z
  .object({ title: text('Title', 500).optional(), content: text('Content', 100_000).optional() })
  .refine((c) => c.title !== undefined || c.content !== undefined, 'Nothing to update');

// PATCH /api/newsletters/[id] { title?, content? }: edit one of your own newsletters
export const PATCH = api<{ id: string }>(async (request, ctx, params) => {
  const id = assertUuid(params.id, 'newsletter id');
  if (!ctx.has('manage_newsletters')) throw new HttpError(403, 'You do not have permission to edit newsletters');
  const input = await readJson(request, changes);
  const updated = await updateNewsletter(ctx.userId, id, input);
  if (!updated) throw new HttpError(404, 'Newsletter not found');
  return ok(updated);
});

// DELETE /api/newsletters/[id]: delete one of your own newsletters
export const DELETE = api<{ id: string }>(async (_request, ctx, params) => {
  const blocked = checkDemoModeForDestructiveAction('delete_newsletter');
  if (blocked) return blocked;
  const id = assertUuid(params.id, 'newsletter id');
  if (!ctx.has('manage_newsletters')) throw new HttpError(403, 'You do not have permission to delete newsletters');
  if (!(await deleteNewsletter(ctx.userId, id))) throw new HttpError(404, 'Newsletter not found');
  return ok({ id });
});
