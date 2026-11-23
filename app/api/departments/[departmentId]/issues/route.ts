import { api, ok, assertUuid } from '@/lib/api/context';
import { projectIssuesService } from '@/lib/project-issues-service';

// GET /api/departments/[departmentId]/issues: open and in-progress issues of projects the department's
// people work on, for the department page (moved off browser queries). Runs as the signed-in user, so
// row-level security applies.
export const GET = api<{ departmentId: string }>(async (_request, ctx, params) => {
  const departmentId = assertUuid(params.departmentId, 'department id');
  return ok(await projectIssuesService.getDepartmentActiveIssues(departmentId, ctx.supabase));
});
