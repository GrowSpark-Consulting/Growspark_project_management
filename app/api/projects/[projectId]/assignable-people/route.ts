import { api, ok, assertUuid } from '@/lib/api/context';

// GET /api/projects/[projectId]/assignable-people: the project team with their role names, for the task
// dialog's assignee list (moved off browser queries). Runs as the signed-in user, so row-level security
// applies. An assignee must be on the project team (the task API refuses anyone else).
export const GET = api<{ projectId: string }>(async (_request, ctx, params) => {
  const projectId = assertUuid(params.projectId, 'project id');
  const db = ctx.supabase;
  const { data: project, error } = await db.from('projects').select('id, account_id').eq('id', projectId).single();
  if (error || !project) return ok([]);

  const people = new Map<string, { id: string; name: string; roles: string[] }>();
  const { data: members } = await db.from('project_assignments')
    .select('user_id, user_profiles!project_assignments_user_id_fkey ( id, name, email )')
    .eq('project_id', projectId).is('removed_at', null);
  for (const m of (members || []) as any[]) {
    const p = m.user_profiles;
    if (p?.id && !people.has(p.id)) people.set(p.id, { id: p.id, name: p.name || 'Unknown', roles: [] });
  }

  const ids = [...people.keys()];
  if (ids.length) {
    const { data: userRoles, error: rolesError } = await db.from('user_roles')
      .select('user_id, roles!user_roles_role_id_fkey ( id, name )').in('user_id', ids);
    if (!rolesError) for (const ur of (userRoles || []) as any[]) {
      const person = people.get(ur.user_id);
      const roleName = ur.roles?.name || 'No Role';
      if (person && !person.roles.includes(roleName)) person.roles.push(roleName);
    }
  }
  for (const person of people.values()) if (!person.roles.length) person.roles = ['Team Member'];
  return ok([...people.values()]);
});
