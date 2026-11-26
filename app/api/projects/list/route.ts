/* eslint-disable @typescript-eslint/no-explicit-any */
import { api, ok } from '@/lib/api/context';
import { Permission } from '@/lib/permissions';
import { Prisma } from '@/lib/db/generated/client';
import { withUser, schemaName } from '@/lib/db';
import { wantsPage, readPage, pageInfo, searchTerm, type PageRequest } from '@/lib/pagination';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORTS = ['name', 'priority', 'account', 'deadline', 'status'] as const;
type Sort = (typeof SORTS)[number];

/**
 * One page of the visible project ids, in SQL (run as the user, so row-level security applies): the same
 * visibility as below (open, unarchived; everything with view-all, else created / lead / assigned / tasks),
 * optional name search and department filter, the sort, and LIMIT/OFFSET with a count.
 */
async function pageOfIds(userId: string, viewAll: boolean, page: PageRequest, opts: { q: string; department: string | null; sort: Sort | null; desc: boolean }) {
  const s = schemaName();
  const t = (name: string) => Prisma.raw(s ? `"${s}".${name}` : name);
  const where = [Prisma.sql`p.status <> 'complete'`, Prisma.sql`p.archived_at is null`];
  if (!viewAll) {
    where.push(Prisma.sql`(p.created_by = ${userId}::uuid or p.assigned_user_id = ${userId}::uuid
      or exists (select 1 from ${t('project_assignments')} pa where pa.project_id = p.id and pa.user_id = ${userId}::uuid and pa.removed_at is null)
      or exists (select 1 from ${t('tasks')} tk where tk.project_id = p.id and tk.assigned_to = ${userId}::uuid))`);
  }
  if (opts.q) where.push(Prisma.sql`p.name ilike ${'%' + opts.q + '%'}`);
  if (opts.department) {
    where.push(Prisma.sql`exists (select 1 from ${t('project_assignments')} pa
      join ${t('user_roles')} ur on ur.user_id = pa.user_id
      join ${t('roles')} r on r.id = ur.role_id
      where pa.project_id = p.id and pa.removed_at is null and r.department_id = ${opts.department}::uuid)`);
  }
  const dir = Prisma.raw(opts.desc ? 'desc' : 'asc');
  const orderBy = {
    name: Prisma.sql`lower(p.name) ${dir}`,
    priority: Prisma.sql`case p.priority when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end ${dir}`,
    account: Prisma.sql`lower(coalesce(a.name, '')) ${dir}`,
    deadline: Prisma.sql`p.end_date ${dir} nulls last`,
    status: Prisma.sql`case p.status when 'on_hold' then 1 when 'planning' then 2 when 'in_progress' then 3 when 'review' then 4 when 'complete' then 5 else 0 end ${dir}`,
  };
  const order = opts.sort ? Prisma.sql`${orderBy[opts.sort]}, p.id` : Prisma.sql`p.created_at desc, p.id`;
  const from = Prisma.sql`from ${t('projects')} p left join ${t('accounts')} a on a.id = p.account_id where ${Prisma.join(where, ' and ')}`;
  return withUser(userId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`select p.id ${from} order by ${order} limit ${page.pageSize} offset ${page.from}`;
    const total = await tx.$queryRaw<Array<{ n: number }>>`select count(*)::int as n ${from}`;
    return { ids: rows.map((r) => r.id), total: total[0]?.n ?? 0 };
  });
}

// GET /api/projects/list: the Projects page's list (moved off browser queries). The same lookups the
// page used to run, as the signed-in user, so row-level security applies: open, unarchived projects the
// user can see (all of them with the view-all-projects permission; otherwise ones they created, lead,
// are assigned to or have tasks on), each with its departments, current workflow step and team.
//
// With page/pageSize (20, 50, 100): one page in { data, meta: { pagination, departments } }, filtered and sorted
// by the database: q (name search), department (id), sort (name|priority|account|deadline|status), order (asc|desc).
// Without them: every visible project (as before).
export const GET = api(async (request, ctx) => {
  const db = ctx.supabase;
  const me = ctx.userId;
  const viewAll = ctx.isSuperadmin || ctx.has(Permission.VIEW_ALL_PROJECTS);
  const params = new URL(request.url).searchParams;

  if (wantsPage(params)) {
    const page = readPage(params);
    const department = params.get('department');
    const sort = (SORTS as readonly string[]).includes(params.get('sort') || '') ? (params.get('sort') as Sort) : null;
    const { data: departments } = await db.from('departments').select('id, name').order('name');
    // Without view-projects (or view-all) the Projects page shows nothing, as its per-project checks did
    if (!viewAll && !ctx.has(Permission.VIEW_PROJECTS)) {
      return ok([], 200, { pagination: pageInfo(page, 0), departments: departments || [] });
    }
    const { ids, total } = await pageOfIds(me, viewAll, page, {
      q: searchTerm(params),
      department: department && UUID.test(department) ? department : null,
      sort,
      desc: params.get('order') === 'desc',
    });
    const meta = { pagination: pageInfo(page, total), departments: departments || [] };
    if (!ids.length) return ok([], 200, meta);
    const details = await withDetails(db, ids);
    const byId = new Map(details.map((p: any) => [p.id, p]));
    return ok(ids.map((id) => byId.get(id)).filter(Boolean), 200, meta);
  }

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
  if (!projects.length) return ok([]);
  return ok(await enrich(db, projects));
});

/** The projects with these ids, with their account and details (row-level security applies). */
async function withDetails(db: any, ids: string[]) {
  const { data, error } = await db.from('projects').select('*, account:accounts(*)').in('id', ids);
  if (error) throw error;
  return enrich(db, data || []);
}

/** Departments of the assigned people, the current workflow step and the team, for each project. */
async function enrich(db: any, projects: any[]) {
  const projectIds = projects.map((p: any) => p.id);
  if (!projectIds.length) return [];

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

  return projects.map((p: any) => ({
    ...p,
    departments: departmentsByProject[p.id] || [],
    workflow_step: steps[p.id] || null,
    assigned_users: people[p.id] || [],
  }));
}
