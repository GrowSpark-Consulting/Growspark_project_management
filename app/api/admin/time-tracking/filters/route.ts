import { api, ok } from '@/lib/api/context';

// GET /api/admin/time-tracking/filters: the people and projects for the admin time-tracking filters
// (moved off browser queries). Runs as the signed-in user, so row-level security applies, as before.
export const GET = api(async (_request, ctx) => {
  const [users, projects] = await Promise.all([
    ctx.supabase.from('user_profiles').select('id, name').order('name'),
    ctx.supabase.from('projects').select('id, name').order('name'),
  ]);
  return ok({ users: users.error ? null : users.data || [], projects: projects.error ? null : projects.data || [] });
});
