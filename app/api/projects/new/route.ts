import { z } from 'zod';
import { api, ok, readJson } from '@/lib/api/context';
import { uuidSchema } from '@/lib/validation-schemas';

// /api/projects/new: the "Create New Project" dialog (moved off browser queries). Runs the same reads
// and insert the dialog used to run, as the signed-in user, so row-level security decides, as before.

// GET: the accounts and active workflows to pick from (null when a list could not be read)
export const GET = api(async (_request, ctx) => {
  const [accounts, workflows] = await Promise.all([
    ctx.supabase.from('accounts').select('id, name').order('name'),
    ctx.supabase.from('workflow_templates').select('id, name, description').eq('is_active', true).order('name'),
  ]);
  return ok({ accounts: accounts.error ? null : accounts.data || [], workflows: workflows.error ? null : workflows.data || [] });
});

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// POST: create the project (the dialog then starts the chosen workflow through /api/workflows/start)
export const POST = api(async (request, ctx) => {
  const body = await readJson(request, z.object({
    name: z.string().trim().min(1).max(500),
    description: z.string().max(5000).optional().nullable(),
    accountId: uuidSchema,
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
    startDate: date.optional().nullable(),
    endDate: date.optional().nullable(),
    estimatedHours: z.number().int().min(0).max(100000).optional().nullable(),
    assignToMe: z.boolean().optional(), // the account page's dialog makes the creator the lead
  }));
  const { data, error } = await ctx.supabase
    .from('projects')
    .insert({
      name: body.name,
      description: body.description || null,
      account_id: body.accountId,
      status: 'planning',
      priority: body.priority,
      start_date: body.startDate ?? null,
      end_date: body.endDate ?? null,
      estimated_hours: body.estimatedHours ?? null,
      actual_hours: 0,
      created_by: ctx.userId,
      ...(body.assignToMe ? { assigned_user_id: ctx.userId } : {}),
    })
    .select()
    .single();
  if (error) throw error;
  return ok(data, 201);
});
