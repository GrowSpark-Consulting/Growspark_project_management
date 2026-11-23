import { api, ok, assertUuid } from '@/lib/api/context';

// GET /api/accounts/[accountId]/finished-projects: the account's completed projects, newest first, for
// the account page (moved off browser queries). Runs as the signed-in user, so row-level security applies.
export const GET = api<{ accountId: string }>(async (_request, ctx, params) => {
  const accountId = assertUuid(params.accountId, 'account id');
  const { data, error } = await ctx.supabase
    .from('projects')
    .select('*, account:accounts(id, name)')
    .eq('account_id', accountId)
    .eq('status', 'complete')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return ok(data || []);
});
