import { api, ok, assertUuid } from '@/lib/api/context';
import { projectIssuesService } from '@/lib/project-issues-service';

// GET /api/accounts/[accountId]/issues: open and in-progress issues of the account's projects, for the
// account page (moved off browser queries). Runs as the signed-in user, so row-level security applies.
export const GET = api<{ accountId: string }>(async (_request, ctx, params) => {
  const accountId = assertUuid(params.accountId, 'account id');
  return ok(await projectIssuesService.getAccountActiveIssues(accountId, ctx.supabase));
});
