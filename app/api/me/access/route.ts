import { z } from 'zod';
import { api, ok, HttpError } from '@/lib/api/context';
import { uuidSchema } from '@/lib/validation-schemas';
import { isAssignedToProject, hasAccountAccess, isAssignedToWorkflowNode } from '@/lib/permission-checker';
import { isAccountManager } from '@/lib/rbac';

// GET /api/me/access: the database lookups behind the browser's permission checks
// (lib/permission-checker.ts), moved off browser queries. Each runs the checker's own helper on the
// server as the signed-in user, so row-level security applies, as before.
//   check=project&userId=&projectId=     assigned to the project (creator, lead, team or a task)
//   check=account&userId=&accountId=     access to the account (member, manager, or on one of its projects)
//   check=workflow-node&workflowInstanceId=   the signed-in user may act on the run's current step
//   check=roles&roleIds=a,b              the roles' permissions (id, name, permissions)
//   check=project-account&projectId=     the project's account
//   check=account-manager                the signed-in user manages at least one account
const ids = z.string().max(4000).transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)).pipe(z.array(uuidSchema).max(50));
const query = z.discriminatedUnion('check', [
  z.object({ check: z.literal('project'), userId: uuidSchema, projectId: uuidSchema }),
  z.object({ check: z.literal('account'), userId: uuidSchema, accountId: uuidSchema }),
  z.object({ check: z.literal('workflow-node'), workflowInstanceId: uuidSchema }),
  z.object({ check: z.literal('roles'), roleIds: ids }),
  z.object({ check: z.literal('project-account'), projectId: uuidSchema }),
  z.object({ check: z.literal('account-manager') }),
]);

export const GET = api(async (request, ctx) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new HttpError(400, 'Invalid access check');
  const q = parsed.data;
  const db = ctx.supabase as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (q.check) {
    case 'project':
      return ok(await isAssignedToProject(q.userId, q.projectId, db));
    case 'account':
      return ok(await hasAccountAccess(q.userId, q.accountId, db));
    case 'workflow-node':
      return ok(await isAssignedToWorkflowNode(ctx.user, q.workflowInstanceId, db));
    case 'roles': {
      if (!q.roleIds.length) return ok([]);
      const { data, error } = await db.from('roles').select('id, name, permissions').in('id', q.roleIds);
      if (error) throw error;
      return ok(data || []);
    }
    case 'account-manager':
      return ok(await isAccountManager(ctx.user, db));
    case 'project-account': {
      const { data } = await db.from('projects').select('account_id').eq('id', q.projectId).single();
      return ok(data?.account_id ?? null);
    }
  }
}, 'any');
