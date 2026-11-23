import { z } from 'zod';
import { api, ok, readJson, HttpError } from '@/lib/api/context';
import { listPublishedNewsletters, createNewsletter } from '@/lib/modules/newsletters/service';

const text = (field: string, max: number) =>
  z.string().max(max, `${field} is too long`).refine((s) => s.trim().length > 0, `${field} is required`);

const newsletterInput = z.object({ title: text('Title', 500), content: text('Content', 100_000) });

// GET /api/newsletters: the 20 most recently published newsletters
export const GET = api(async (_request, ctx) => {
  if (!ctx.has('view_newsletters') && !ctx.has('manage_newsletters')) {
    throw new HttpError(403, 'You do not have access to newsletters');
  }
  return ok(await listPublishedNewsletters(ctx.userId));
});

// POST /api/newsletters { title, content }: create a newsletter, published straight away
export const POST = api(async (request, ctx) => {
  if (!ctx.has('manage_newsletters')) throw new HttpError(403, 'You do not have permission to create newsletters');
  const input = await readJson(request, newsletterInput);
  return ok(await createNewsletter(ctx.userId, input), 201);
});
