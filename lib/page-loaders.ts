/**
 * The server-side data of the pages that render on the server, one loader per page. Each is the logic
 * that used to sit in the page itself, unchanged; it runs where the database is: in the page on
 * Render or locally, or behind GET /api/pages/<path> for the frontend-only server (lib/page-data.ts).
 */
import { wantsPage, readPage, pageInfo, searchTerm, type PageInfo } from '@/lib/pagination';
import { createServerSupabase, createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCurrentUserProfileServer } from '@/lib/auth-server';
import { accountService } from '@/lib/account-service';
import { serverDepartmentService, type DepartmentMetrics } from '@/lib/department-service';
import {
  canManageAccounts, canManageDepartment, canViewAccounts, canViewDepartment, hasPermission, isAdminLevel,
  isSuperadmin, type UserWithRoles,
} from '@/lib/rbac';
import { checkPermissionHybrid, isSuperadmin as isSuperadminChecker } from '@/lib/permission-checker';
import { Permission } from '@/lib/permissions';
import { isManagerProfile, profilePermissions } from '@/lib/portal';
import type { PageOutcome } from '@/lib/page-data';

const ok = <T>(data: T): PageOutcome<T> => ({ kind: 'ok', data });
const to = (path: string): PageOutcome<never> => ({ kind: 'redirect', to: path });
const denied = (reason: string): PageOutcome<never> => ({ kind: 'denied', reason });
const missing: PageOutcome<never> = { kind: 'notFound' };

/** Manager portal guard: managers (superadmin, manage_projects, manage_all_projects, approve_timesheets) or org-wide viewers. */
export async function managerAccess(): Promise<PageOutcome<{ allowed: boolean }>> {
  const supabase = await createServerSupabase();
  if (!supabase) return to('/login');
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return to('/login?redirectTo=/manager');
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, is_superadmin, is_client, is_active, user_roles!user_roles_user_id_fkey(roles!user_roles_role_id_fkey(name, is_system_role, permissions))')
    .eq('id', user.id)
    .single();
  if (!profile) return to('/login');
  if (profile.is_client) return to('/client-portal');
  if (profile.is_active === false) return to('/login?error=deactivated');
  return ok({ allowed: isManagerProfile(profile as never) || profilePermissions(profile as never).has('view_all_projects') });
}

/** Client portal guard and sidebar details. */
export async function clientPortal(): Promise<PageOutcome<{ userName: string; userEmail: string; accountName: string }>> {
  const supabase = await createServerSupabase();
  if (!supabase) return to('/login');
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return to('/login');

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('is_client, client_account_id, name, email, is_active')
    .eq('id', user.id)
    .single();
  // Not a client user: the internal dashboard
  if (!profile?.is_client) return to('/dashboard');
  if (profile.is_active === false) return to('/login?error=deactivated');

  // Account name for the sidebar (clients have no direct table access; read server-side)
  let accountName = 'Unknown Account';
  const admin = createAdminSupabaseClient();
  if (profile.client_account_id && admin) {
    const { data: account } = await admin.from('accounts').select('name').eq('id', profile.client_account_id).single();
    if (account?.name) accountName = account.name;
  }
  return ok({ userName: profile.name || 'Client User', userEmail: profile.email || '', accountName });
}

/** Workflow builder access. */
export async function workflowsAccess(): Promise<PageOutcome<{ canManageWorkflows: boolean }>> {
  const login = to('/login?redirectTo=/admin/workflows');
  const supabase = await createServerSupabase();
  if (!supabase) return login;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return login;
  const { data } = await supabase
    .from('user_profiles')
    .select(`
      *,
      user_roles!user_roles_user_id_fkey(
        id,
        role_id,
        assigned_at,
        assigned_by,
        roles!user_roles_role_id_fkey(
          *,
          departments!roles_department_id_fkey(*)
        )
      )
    `)
    .eq('id', user.id)
    .single();
  const userProfile = data as unknown as UserWithRoles | null;
  if (!userProfile) return login;

  const canManageWorkflows = isSuperadminChecker(userProfile) ||
    await checkPermissionHybrid(userProfile, Permission.MANAGE_WORKFLOWS, undefined, supabase);
  const canManageAllWorkflows = isSuperadminChecker(userProfile) ||
    await checkPermissionHybrid(userProfile, Permission.MANAGE_ALL_WORKFLOWS, undefined, supabase);
  if (!canManageWorkflows && !canManageAllWorkflows) return denied('forbidden');
  return ok({ canManageWorkflows: canManageWorkflows || canManageAllWorkflows });
}

type Profile = NonNullable<Awaited<ReturnType<typeof getCurrentUserProfileServer>>>;

/** Accounts list. Denied reasons: database, login, forbidden. */
type Accounts = Awaited<ReturnType<typeof accountService.getAllAccounts>>;

/**
 * With page/pageSize in `params` (and optional q): one page of the visible accounts, searched and paged by
 * the database, plus `pagination`. Without: every visible account (as before).
 */
export async function accountsPage(params?: URLSearchParams): Promise<PageOutcome<{ userProfile: Profile; isAdminLevel: boolean; accounts: Accounts; pagination?: PageInfo; q?: string }>> {
  // Server-side Supabase client with auth first (needed for permission checks)
  const supabase = await createServerSupabase();
  if (!supabase) return denied('database');
  const userProfile = await getCurrentUserProfileServer();
  if (!userProfile) return denied('login');

  // VIEW_ACCOUNTS, MANAGE_ACCOUNTS, or account manager
  if (!(await canViewAccounts(userProfile, supabase))) return denied('forbidden');

  // Admin-level access (can manage all accounts)
  const adminLevel = isSuperadmin(userProfile) || await canManageAccounts(userProfile, supabase);

  // Admin client for reads; the permission checks above decide what is shown
  const adminClient = createAdminSupabaseClient();
  if (params && wantsPage(params)) {
    const page = readPage(params);
    const q = searchTerm(params);
    // Who sees what: everything at admin level, otherwise the accounts they manage or belong to
    let ids: string[] | null = null;
    if (!adminLevel) ids = (await accountService.getUserAccounts((userProfile as any).id, adminClient)).map((a: any) => a.id);
    if (ids && ids.length === 0) return ok({ userProfile, isAdminLevel: adminLevel, accounts: [], pagination: pageInfo(page, 0), q });
    let query = (adminClient as any).from('accounts').select('*', { count: 'exact' });
    if (ids) query = query.in('id', ids);
    if (q) query = query.or(`name.ilike.*${q}*,primary_contact_name.ilike.*${q}*,description.ilike.*${q}*`);
    const { data, count, error } = await query.order('name').order('id').range(page.from, page.to);
    if (error) throw error;
    return ok({ userProfile, isAdminLevel: adminLevel, accounts: data || [], pagination: pageInfo(page, count || 0), q });
  }
  const accounts = adminLevel
    ? await accountService.getAllAccounts(adminClient)
    : await accountService.getUserAccounts((userProfile as any).id, adminClient);
  return ok({ userProfile, isAdminLevel: adminLevel, accounts });
}

/** One account. Denied reasons: login, database, forbidden. */
export async function accountPage(accountId: string): Promise<PageOutcome<{
  account: any; metrics: any; urgentItems: any; userProfile: Profile; hasFullAccess: boolean;
}>> {
  const userProfile = await getCurrentUserProfileServer();
  if (!userProfile) return denied('login');
  const supabase = await createServerSupabase();
  if (!supabase) return denied('database');

  // Access to this specific account
  const hasAllAccountsPermission = await hasPermission(userProfile, Permission.VIEW_ALL_ACCOUNTS);
  const hasAccountPermission = await hasPermission(userProfile, Permission.VIEW_ACCOUNTS, { accountId });
  const hasAccountAccessViaService = await accountService.canUserAccessAccount((userProfile as any).id, accountId, supabase);
  if (!(hasAllAccountsPermission || hasAccountPermission || hasAccountAccessViaService)) return denied('forbidden');

  // Full (edit) access: MANAGE_ACCOUNTS for this account, VIEW_ALL_ACCOUNTS + MANAGE_ACCOUNTS,
  // account manager, or MANAGE_ALL_PROJECTS. Otherwise read-only (project stakeholder).
  const [canEditAccount, hasViewAllAccounts, hasManageAllProjects, hasFullAccessViaService] = await Promise.all([
    hasPermission(userProfile, Permission.MANAGE_ACCOUNTS, { accountId }),
    hasPermission(userProfile, Permission.VIEW_ALL_ACCOUNTS),
    hasPermission(userProfile, Permission.MANAGE_ALL_PROJECTS),
    accountService.hasFullAccountAccess((userProfile as any).id, accountId, supabase),
  ]);
  const hasBaseEditAccount = hasViewAllAccounts ? await hasPermission(userProfile, Permission.MANAGE_ACCOUNTS) : false;
  const hasFullAccess = canEditAccount || (hasViewAllAccounts && hasBaseEditAccount) || hasManageAllProjects || hasFullAccessViaService;

  // Admin client for the data; permission verified above (account_members is not readable through RLS here)
  const queryClient = createAdminSupabaseClient() || supabase;
  const [account, metrics, urgentItems] = await Promise.all([
    accountService.getAccountById(accountId, undefined, queryClient as any),
    accountService.getAccountMetrics(accountId, queryClient as any),
    accountService.getUrgentItems(accountId, queryClient as any),
  ]);
  if (!account) return missing;
  return ok({ account, metrics, urgentItems, userProfile, hasFullAccess });
}

/** Departments list. Denied reasons: login, forbidden. */
export async function departmentsPage(): Promise<PageOutcome<{
  departments: any[]; departmentMetrics: Record<string, DepartmentMetrics>; canManageDepartments: boolean; userProfile: Profile;
}>> {
  const userProfile = await getCurrentUserProfileServer();
  if (!userProfile) return denied('login');

  const canViewAnyDepartments = await hasPermission(userProfile, Permission.VIEW_DEPARTMENTS) ||
    await hasPermission(userProfile, Permission.VIEW_ALL_DEPARTMENTS);
  if (!canViewAnyDepartments) return denied('forbidden');

  const allDepartments = await serverDepartmentService.getAllDepartments();
  // VIEW_ALL_DEPARTMENTS shows all; otherwise only the departments the user may view
  const hasViewAllDepartments = await hasPermission(userProfile, Permission.VIEW_ALL_DEPARTMENTS);
  let departments = allDepartments;
  if (!hasViewAllDepartments) {
    const accessChecks = await Promise.all(
      allDepartments.map(async (dept: any) => ({ dept, canView: await canViewDepartment(userProfile, dept.id) })),
    );
    departments = accessChecks.filter(({ canView }) => canView).map(({ dept }) => dept);
  }

  // Metrics for the visible departments, in parallel
  const metricsResults = await Promise.all(departments.map((dept: any) => serverDepartmentService.getDepartmentMetrics(dept.id)));
  const departmentMetrics: Record<string, DepartmentMetrics> = {};
  metricsResults.forEach((metrics: any, index: number) => {
    if (metrics) departmentMetrics[departments[index].id] = metrics;
  });

  const canManageDepartments = await hasPermission(userProfile, Permission.MANAGE_DEPARTMENTS);
  return ok({ departments, departmentMetrics, canManageDepartments, userProfile });
}

/** One department. */
export async function departmentPage(departmentId: string): Promise<PageOutcome<{
  department: any; metrics: any; projects: any; canManageDepartments: boolean; userProfile: Profile;
}>> {
  const userProfile = await getCurrentUserProfileServer();
  if (!userProfile) return missing;

  // VIEW_ALL_DEPARTMENTS override, or access to this department
  const hasViewAllDepartments = await hasPermission(userProfile, Permission.VIEW_ALL_DEPARTMENTS);
  const canViewThisDepartment = await canViewDepartment(userProfile, departmentId);
  if (!hasViewAllDepartments && !canViewThisDepartment) return missing;

  const department = await serverDepartmentService.getDepartmentById(departmentId);
  if (!department) return missing;
  const metrics = await serverDepartmentService.getDepartmentMetrics(departmentId);
  if (!metrics) return missing;
  const projects = await serverDepartmentService.getDepartmentProjects(departmentId);
  const canManageDepartments = await canManageDepartment(userProfile, departmentId);
  return ok({ department, metrics, projects, canManageDepartments, userProfile });
}

/** Department administration (admin-level users only). */
export async function departmentAdminPage(departmentId: string): Promise<PageOutcome<{ departmentName: string }>> {
  const supabase = await createServerSupabase();
  if (!supabase) return to('/login');
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return to('/login');

  // Profile with roles (must include is_superadmin and role permissions)
  const { data: userProfile, error: profileError } = await supabase
    .from('user_profiles')
    .select(`
      *,
      user_roles!user_roles_user_id_fkey (
        id,
        role_id,
        roles!user_roles_role_id_fkey (
          id,
          name,
          department_id,
          permissions,
          is_system_role,
          departments!roles_department_id_fkey (
            id,
            name
          )
        )
      )
    `)
    .eq('id', (user as any).id)
    .single();
  if (profileError || !userProfile) return to('/login');
  if (!(await isAdminLevel(userProfile as unknown as UserWithRoles))) return to('/departments');

  const { data: department, error: departmentError } = await supabase.from('departments').select('*').eq('id', departmentId).single();
  if (departmentError || !department) return to('/departments');
  return ok({ departmentName: department.name });
}

export type TitleKind = 'account' | 'department' | 'project';

/** The name shown in the browser tab for an account, department or project (null: generic title). */
export async function pageTitle(kind: TitleKind, id: string): Promise<PageOutcome<{ title: string | null }>> {
  if (kind === 'department') {
    const department = await serverDepartmentService.getDepartmentById(id);
    return ok({ title: department?.name || null });
  }
  const supabase = await createServerSupabase();
  if (!supabase) return ok({ title: null });
  const { data } = await supabase.from(kind === 'account' ? 'accounts' : 'projects').select('name').eq('id', id).single();
  return ok({ title: data?.name || null });
}

/** Whether a single-segment URL (e.g. /growspark) is this installation's workspace address. */
export async function workspaceMatches(slug: string): Promise<PageOutcome<{ matches: boolean }>> {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return ok({ matches: false });
  const admin = createAdminSupabaseClient();
  if (!admin) return ok({ matches: false });
  const { data } = await admin.from('app_settings').select('workspace_slug').eq('id', true).maybeSingle();
  return ok({ matches: !!data?.workspace_slug && data.workspace_slug === slug });
}

/** GET /api/pages/<path>: the loader for a path, or null when no page uses that path. */
export function loaderFor(path: string[], params?: URLSearchParams): (() => Promise<PageOutcome<unknown>>) | null {
  const [first, second, third] = path;
  const shape = path.length === 1 ? first : path.length === 2 ? `${first}/*` : path.length === 3 ? `${first}/*/${third}` : '';
  switch (shape) {
    case 'manager': return managerAccess;
    case 'client-portal': return clientPortal;
    case 'admin-workflows': return workflowsAccess;
    case 'accounts': return () => accountsPage(params);
    case 'accounts/*': return () => accountPage(second);
    case 'departments': return departmentsPage;
    case 'departments/*': return () => departmentPage(second);
    case 'departments/*/admin': return () => departmentAdminPage(second);
    case 'workspace/*': return () => workspaceMatches(second);
  }
  if (path.length === 3 && first === 'title' && ['account', 'department', 'project'].includes(second)) {
    return () => pageTitle(second as TitleKind, third);
  }
  return null;
}
