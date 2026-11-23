import { z } from 'zod';
import { uuidSchema } from '@/lib/validation-schemas';
import { api, ok, HttpError } from '@/lib/api/context';

// GET /api/breadcrumb?type=project|account|department&id=: the name shown in the breadcrumb (and a
// project's account), moved off browser queries. Runs as the signed-in user, so row-level security
// decides; anything the user cannot see returns null.
const query = z.object({ type: z.enum(['project', 'account', 'department']), id: uuidSchema });

export const GET = api(async (request, ctx) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new HttpError(400, 'Invalid breadcrumb request');
  const { type, id } = parsed.data;
  if (type === 'project') {
    const { data } = await ctx.supabase.from('projects').select('name, account_id, accounts(name)').eq('id', id).maybeSingle();
    return ok(data ? { name: data.name, accountId: data.account_id, accountName: data.accounts?.name ?? null } : null);
  }
  const { data } = await ctx.supabase.from(type === 'account' ? 'accounts' : 'departments').select('name').eq('id', id).maybeSingle();
  return ok(data ? { name: data.name } : null);
});
