import { api, ok } from '@/lib/api/context';
import { Permission } from '@/lib/permissions';

// GET /api/projects/list: the Projects page's list (moved off browser queries). The same lookups the
// page used to run, as the signed-in user, so row-level security applies: open, unarchived projects the
// user can see (all of them with the view-all-projects permission; otherwise ones they created, lead,
// are assigned to or have tasks on), each with its departments, current workflow step and team.
export const GET = api(async (_request, ctx) => {
  const db = ctx.supabase;
  const me = ctx.userId;
  const viewAll = ctx.isSuperadmin || ctx.has(Permission.VIEW_ALL_PROJECTS);

  let ids: string[] = [];
  if (!viewAll) {
    const [direct, assigned, tasks] = await Promise.all([
      db.from('projects').select('id').or(`created_by.eq.${me},assigned_user_id.eq.${me}`),
      db.from('project_assignments').select('project_id').eq('user_id', me).is('removed_at', null),
      db.from('tasks').select('project_id').eq('assigned_to', me),
    ]);
    ids = Array.from(new Set([
      ...(direct.data || []).map((p: any) => p.id),
      ...(assigned.data || []).map((p: any) => p.project_id),
      ...(tasks.data || []).map((t: any) => t.project_id),
    ].filter(Boolean)));
    if (!ids.length) return ok([]);
  }

  let query = db.from('projects').select('*, account:accounts(*)');
  if (!viewAll) query = query.in('id', ids);
  const { data, error } = await query.neq('status', 'complete').is('archived_at', null);
  if (error) throw error;
  const projects = data || [];
  const projectIds = projects.map((p: any) => p.id);
  if (!projectIds.length) return ok([]);

  // Departments of the people assigned to each project
  const departmentsByProject: Record<string, any[]> = {};
  const { data: assignments } = await db.from('project_assignments').select('project_id, user_id').in('project_id', projectIds).is('removed_at', null);
  if (assignments?.length) {
    const userIds = Array.from(new Set(assignments.map((a: any) => a.user_id)));
    const { data: userRoles } = await db
      .from('user_roles')
      .select('user_id, roles!user_roles_role_id_fkey ( department_id, departments!roles_department_id_fkey ( id, name ) )')
      .in('user_id', userIds);
    const userDepartments: Record<string, any[]> = {};
    for (const ur of userRoles || []) {
      const dept = (ur as any).roles?.departments;
      if (!dept) continue;
      const list = (userDepartments[(ur as any).user_id] ||= []);
      if (!list.some((d) => d.id === dept.id)) list.push(dept);
    }
    for (const a of assignments as any[]) {
      const list = (departmentsByProject[a.project_id] ||= []);
      for (const dept of userDepartments[a.user_id] || []) if (!list.some((d) => d.id === dept.id)) list.push(dept);
    }
  }

  // Current workflow step and the team
  const [workflows, team] = await Promise.all([
    db.from('workflow_instances').select('project_id, current_node_id, workflow_nodes!workflow_instances_current_node_id_fkey ( label )').in('project_id', projectIds).eq('status', 'active'),
    db.from('project_assignments').select('project_id, user_profiles!project_assignments_user_id_fkey ( id, name, email, image )').in('project_id', projectIds).is('removed_at', null),
  ]);
  const steps: Record<string, string | null> = {};
  for (const wi of (workflows.data || []) as any[]) if (wi.project_id) steps[wi.project_id] = wi.workflow_nodes?.label || null;
  const people: Record<string, any[]> = {};
  for (const pa of (team.data || []) as any[]) {
    const list = (people[pa.project_id] ||= []);
    const u = pa.user_profiles;
    if (u && !list.some((x) => x.id === u.id)) list.push({ id: u.id, name: u.name || 'Unknown', email: u.email, image: u.image });
  }

  return ok(projects.map((p: any) => ({
    ...p,
    departments: departmentsByProject[p.id] || [],
    workflow_step: steps[p.id] || null,
    assigned_users: people[p.id] || [],
  })));
});
