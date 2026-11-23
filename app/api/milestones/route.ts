import { z } from 'zod';
import { api, ok, readJson } from '@/lib/api/context';

// /api/milestones: the milestones shown on the account timeline (moved off browser queries).
// Runs as the signed-in user, so row-level security decides who sees and adds them, as before.
// Project milestones are managed under /api/projects/[projectId]/milestones and /api/milestones/[id].
export const GET = api(async (_request, ctx) => {
  const { data, error } = await ctx.supabase.from('milestones').select('*').order('date', { ascending: true });
  if (error) throw error;
  return ok(data || []);
});

export const POST = api(async (request, ctx) => {
  const body = await readJson(request, z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    date: z.string().datetime({ offset: true }),
    color: z.string().max(20).optional(),
  }));
  const { data, error } = await ctx.supabase
    .from('milestones')
    .insert({ name: body.name, description: body.description, date: body.date, color: body.color || '#3b82f6' })
    .select()
    .single();
  if (error) throw error;
  return ok(data, 201);
});
