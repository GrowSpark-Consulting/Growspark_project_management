
import type { AppSupabaseClient } from './supabase';

// Helper functions for status mapping
const getStatusDisplayName = (status: string) => {
  const statusMap: { [key: string]: string } = {
    'planning': 'Planning',
    'in_progress': 'In Progress',
    'review': 'Review',
    'complete': 'Complete',
    'on_hold': 'On Hold'
  };
  return statusMap[status] || 'Planning';
};

const getStatusColor = (status: string) => {
  const colorMap: { [key: string]: string } = {
    'planning': '#6B7280',
    'in_progress': '#3B82F6',
    'review': '#F59E0B',
    'complete': '#10B981',
    'on_hold': '#EF4444'
  };
  return colorMap[status] || '#6B7280';
};

export type Account = any;
export type Project = any;
export type User = any;

export interface AccountWithProjects extends Account {
  projects: ProjectWithDetails[];
  account_manager?: User;
}

export interface ProjectWithDetails {
  id: string;
  name: string;
  description: string | null;
  account_id: string;
  status: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  estimated_hours: number | null;
  actual_hours: number | null;
  remaining_hours?: number | null;
  task_hours_sum?: number;
  start_date: string | null;
  end_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  assigned_user_id?: string | null;
  departments: {
    id: string;
    name: string;
  }[];
  assigned_users: {
    id: string;
    name: string;
    image: string;
  }[];
  stakeholders?: {
    id: string;
    user_id: string;
    role: string;
    user_profiles?: {
      id: string;
      name: string;
      email: string;
      image: string | null;
    };
  }[];
  status_info: {
    id: string;
    name: string;
    color: string;
  };
  workflow_step?: string | null;  // Current workflow step name from workflow_instances
}

export interface AccountMetrics {
  activeProjects: number;
  completedProjects: number;
  totalProjects: number;
  upcomingDeadlines: number;
  overdueProjects: number;
  pendingApprovals: number;
  healthScore: number; // 0-100
}

export interface UrgentItem {
  id: string;
  type: 'project' | 'task' | 'approval';
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  dueDate: Date;
  projectId?: string;
  assigneeId?: string;
}

class AccountService {
  // Get account by ID with related data
  async getAccountById(accountId: string, userMap?: { [key: string]: Record<string, unknown> }, supabaseClient?: AppSupabaseClient | null): Promise<AccountWithProjects | null> {
    try {
      const supabase = supabaseClient;
      if (!supabase) {
        return null;
      }

      type AccountWithManager = Account & {
        user_profiles?: User;
      };

      const { data: account, error: accountError } = await supabase
        .from('accounts')
        .select(`
          *,
          user_profiles!accounts_account_manager_id_fkey(*)
        `)
        .eq('id', accountId)
        .single();

      if (accountError) {
        return null;
      }

      if (!account) return null;

      const typedAccount = account as unknown as AccountWithManager;

      // Get projects for this account
      const projects = await this.getAccountProjects(accountId, userMap, supabase);

      return {
        ...typedAccount,
        projects,
        account_manager: typedAccount.user_profiles,
      };
    } catch {
      return null;
    }
  }

  // Get all accounts
  async getAllAccounts(supabaseClient?: AppSupabaseClient | null): Promise<Account[]> {
    try {
      const supabase = supabaseClient;
      if (!supabase) {
        return [];
      }

      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .order('name');

      if (error) {
        return [];
      }

      return data || [];
    } catch {
      return [];
    }
  }

  // Check if a user can edit a specific project
  async canUserEditProject(userId: string, projectId: string, supabaseClient?: AppSupabaseClient | null): Promise<boolean> {
    try {
      const supabase = supabaseClient;
      if (!supabase) {
        return false;
      }

      // First, check if user is superadmin (bypasses all permission checks)
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('is_superadmin')
        .eq('id', userId)
        .single();

      if (userProfile?.is_superadmin) {
        return true;
      }

      // Check if user has EDIT_ALL_PROJECTS permission or is Superadmin role
      // Get user's roles and permissions
      const { data: userRoles, error: rolesError } = await supabase
        .from('user_roles')
        .select(`
          role_id,
          roles(id, name, permissions, is_system_role)
        `)
        .eq('user_id', userId);

      type UserRoleWithRole = {
        roles?: Record<string, unknown> | null;
      };

      if (!rolesError && userRoles) {
        const typedUserRoles = userRoles as unknown as UserRoleWithRole[];
        for (const ur of typedUserRoles) {
          const role = ur.roles;
          if (!role) continue;

          // Check if role is a system superadmin role
          if ((role as any).is_system_role === true && (role as any).name?.toLowerCase() === 'superadmin') {
            return true;
          }

          const permissions = role.permissions as Record<string, unknown> | null;
          if (!permissions) continue;

          // Check for MANAGE_ALL_PROJECTS permission (consolidated from edit_all_projects in Phase 8-9)
          if (permissions.manage_all_projects === true || permissions.edit_all_projects === true) {
            return true;
          }
        }
      }

      // Get project details
      type ProjectWithAccount = Project & {
        accounts?: { account_manager_id: string | null } | null;
      };

      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select(`
          id,
          created_by,
          assigned_user_id,
          account_id
        `)
        .eq('id', projectId)
        .single();

      if (projectError || !project) {
        return false;
      }

      const typedProject = project as unknown as ProjectWithAccount;

      // Check if user is the project creator
      if (typedProject.created_by === userId) {
        return true;
      }

      // Check if user is the assigned_user_id on the project (legacy field)
      if (typedProject.assigned_user_id === userId) {
        return true;
      }

      // Check if user is the account manager (separate query to avoid RLS issues)
      if (typedProject.account_id) {
        const { data: account } = await supabase
          .from('accounts')
          .select('account_manager_id')
          .eq('id', typedProject.account_id)
          .maybeSingle();

        if (account?.account_manager_id === userId) {
          return true;
        }
      }

      // Check if user has EDIT_PROJECT permission AND is assigned to this project
      if (userRoles) {
        const typedUserRoles = userRoles as unknown as UserRoleWithRole[];
        for (const ur of typedUserRoles) {
          const role = ur.roles;
          if (!role) continue;

          const permissions = role.permissions as Record<string, unknown> | null;
          if (!permissions) continue;

          if (permissions.edit_project === true || permissions.manage_projects === true) {
            // Check if user is actively assigned to this project via project_assignments
            const { data: assignment } = await supabase
              .from('project_assignments')
              .select('id')
              .eq('project_id', projectId)
              .eq('user_id', userId)
              .is('removed_at', null)
              .maybeSingle();

            if (assignment) {
              return true;
            }
          }
        }
      }

      // Stakeholders have read-only access, not edit access
      return false;
    } catch {
      return false;
    }
  }

  // Check if a user can access a specific account
  async canUserAccessAccount(userId: string, accountId: string, supabaseClient?: AppSupabaseClient | null): Promise<boolean> {
    try {
      const supabase = supabaseClient;
      if (!supabase) {
        return false;
      }

      // Check if user is the account manager
      const { data: managedAccount, error: managedError } = await supabase
        .from('accounts')
        .select('id')
        .eq('id', accountId)
        .eq('account_manager_id', userId)
        .single();

      if (managedError && managedError.code !== 'PGRST116') {
        return false;
      }

      if (managedAccount) {
        return true;
      }

      // Check if user is a member of this account (via account_members table)
      const { data: accountMember, error: memberError } = await supabase
        .from('account_members')
        .select('id')
        .eq('account_id', accountId)
        .eq('user_id', userId)
        .single();

      if (memberError && memberError.code !== 'PGRST116' && memberError.code !== '42P01') {
        // Continue checking other access methods
      }

      if (accountMember) {
        return true;
      }

      // Check if user has projects in this account (as creator or assignee)
      const { data: projectAccess, error: projectError } = await supabase
        .from('projects')
        .select('id')
        .eq('account_id', accountId)
        .or(`created_by.eq.${userId},assigned_user_id.eq.${userId}`)
        .limit(1);

      if (projectError) {
        return false;
      }

      // Also check if user is a stakeholder on any project in this account
      if (!projectAccess || projectAccess.length === 0) {
        const { data: stakeholderAccess, error: stakeholderError } = await supabase
          .from('project_stakeholders')
          .select('project_id, projects!inner(account_id)')
          .eq('user_id', userId)
          .eq('projects.account_id', accountId)
          .limit(1);

        if (stakeholderError) {
          return false;
        }

        return (stakeholderAccess && stakeholderAccess.length > 0);
      }

      return (projectAccess && projectAccess.length > 0);
    } catch {
      return false;
    }
  }

  // Check if user has FULL (edit) access to account (not just read-only via project stakeholder)
  async hasFullAccountAccess(userId: string, accountId: string, supabaseClient?: AppSupabaseClient | null): Promise<boolean> {
    try {
      const supabase = supabaseClient;
      if (!supabase) {
        return false;
      }

      // Check if user is the account manager
      const { data: managedAccount, error: managedError } = await supabase
        .from('accounts')
        .select('id')
        .eq('id', accountId)
        .eq('account_manager_id', userId)
        .single();

      if (managedError && managedError.code !== 'PGRST116') {
        return false;
      }

      if (managedAccount) {
        return true;
      }

      // Check if user is a member of this account (via account_members table)
      // Account members have full access to their assigned accounts
      const { data: accountMember, error: memberError } = await supabase
        .from('account_members')
        .select('id')
        .eq('account_id', accountId)
        .eq('user_id', userId)
        .single();

      if (memberError && memberError.code !== 'PGRST116' && memberError.code !== '42P01') {
        // Continue - don't fail the check
      }

      if (accountMember) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  // Get accounts that a user has access to (through projects, membership, or as account manager)
  async getUserAccounts(userId: string, supabaseClient?: AppSupabaseClient | null): Promise<Account[]> {
    try {
      const supabase = supabaseClient;
      if (!supabase) {
        return [];
      }

      // Get accounts where user is the account manager
      const { data: managedAccounts, error: managedError } = await supabase
        .from('accounts')
        .select('*')
        .eq('account_manager_id', userId)
        .order('name');

      if (managedError) {
        return [];
      }

      // Get accounts where user is a member (via account_members table)
      let memberAccounts: Account[] = [];
      const { data: accountMemberships, error: membershipError } = await supabase
        .from('account_members')
        .select('account_id')
        .eq('user_id', userId);

      type AccountMembership = {
        account_id: string;
      };

      if (membershipError && membershipError.code !== '42P01') {
        // Continue - don't fail the whole query
      } else if (accountMemberships && accountMemberships.length > 0) {
        const typedMemberships = accountMemberships as unknown as AccountMembership[];
        const memberAccountIds = typedMemberships.map((am:any) => am.account_id);

        // Fetch the actual account data
        const { data: memberAccountData, error: memberAccountDataError } = await supabase
          .from('accounts')
          .select('*')
          .in('id', memberAccountIds);

        if (!memberAccountDataError && memberAccountData) {
          memberAccounts = memberAccountData as Account[];
        }
      }

      // Get accounts where user has projects assigned (as creator)
      type ProjectAccountId = {
        account_id: string;
      };

      let createdProjectAccountIds: string[] = [];
      const { data: createdProjects, error: createdProjectError } = await supabase
        .from('projects')
        .select('account_id')
        .eq('created_by', userId);

      if (!createdProjectError && createdProjects) {
        const typedProjects = createdProjects as unknown as ProjectAccountId[];
        createdProjectAccountIds = typedProjects.map((p:any) => p.account_id).filter(Boolean);
      }

      // Get accounts where user is assigned to projects (as assignee)
      let assignedProjectAccountIds: string[] = [];
      const { data: assignedProjects, error: assignedProjectError } = await supabase
        .from('projects')
        .select('account_id')
        .eq('assigned_user_id', userId);

      if (!assignedProjectError && assignedProjects) {
        const typedAssigned = assignedProjects as unknown as ProjectAccountId[];
        assignedProjectAccountIds = typedAssigned.map((p:any) => p.account_id).filter(Boolean);
      }

      // Get accounts via projects the user is assigned to
      // First get project IDs from assignments, then query projects with account join
      // This works because PM has VIEW_PROJECTS permission
      let projectAssignmentAccounts: Account[] = [];
      const { data: projectAssignments, error: projectAssignmentsError } = await supabase
        .from('project_assignments')
        .select('project_id')
        .eq('user_id', userId)
        .is('removed_at', null);

      if (!projectAssignmentsError && projectAssignments && projectAssignments.length > 0) {
        const projectIds = projectAssignments.map((pa: any) => pa.project_id).filter(Boolean);

        // Now query projects directly - PM has VIEW_PROJECTS permission
        // The accounts join should work from projects table
        const { data: projects, error: projectsError } = await supabase
          .from('projects')
          .select(`
            id,
            account_id,
            accounts(id, name, description, status, primary_contact_email, primary_contact_name, account_manager_id, service_tier, created_at, updated_at)
          `)
          .in('id', projectIds);

        if (!projectsError && projects && projects.length > 0) {
          // Extract account objects from projects
          const accountsFromProjects = projects
            .map((p: any) => {
              const account = Array.isArray(p.accounts) ? p.accounts[0] : p.accounts;
              return account;
            })
            .filter((a: any) => a && a.id);

          // Deduplicate by account ID
          const seenIds = new Set<string>();
          projectAssignmentAccounts = accountsFromProjects.filter((a: any) => {
            if (seenIds.has(a.id)) return false;
            seenIds.add(a.id);
            return true;
          }) as Account[];
        }
      }

      // Combine all accounts - use full account objects where available
      const managedAccountsList = (managedAccounts || []) as Account[];
      const memberAccountsList = (memberAccounts || []) as Account[];

      // Start with accounts we already have as full objects
      const allAccounts: Account[] = [
        ...managedAccountsList,
        ...memberAccountsList,
        ...projectAssignmentAccounts
      ];

      // Get IDs of accounts we still need to fetch (from created/assigned project refs)
      const existingIds = new Set(allAccounts.map(a => a.id));
      const idsToFetch = [...createdProjectAccountIds, ...assignedProjectAccountIds]
        .filter(id => id && !existingIds.has(id));

      // Fetch remaining accounts if needed (may be blocked by RLS but try anyway)
      if (idsToFetch.length > 0) {
        const { data: additionalAccounts } = await supabase
          .from('accounts')
          .select('*')
          .in('id', idsToFetch);

        if (additionalAccounts) {
          allAccounts.push(...(additionalAccounts as Account[]));
        }
      }

      // Remove duplicates based on account ID
      const uniqueAccounts = allAccounts.filter((account, index, self) =>
        index === self.findIndex((a) => a.id === account.id)
      );

      return uniqueAccounts;
    } catch {
      return [];
    }
  }

  // Get projects for a specific account
  // Pass a supabase client to ensure proper auth context (server or client)
  async getAccountProjects(accountId: string, userMap?: { [key: string]: Record<string, unknown> }, supabaseClient?: AppSupabaseClient | null): Promise<ProjectWithDetails[]> {
    try {
      // Use provided client, or fall back to singleton (less reliable)
      const supabase = supabaseClient;

      if (!supabase) {
        return [];
      }

      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false });

      if (error) {
        return [];
      }

      const typedProjects = (data || []) as Project[];

      // Fetch assigned user data separately for projects that have assigned users
      const projectsWithAssignedUsers = typedProjects.filter((p:any) => p.assigned_user_id);
      const assignedUserIds = projectsWithAssignedUsers.map((p:any) => p.assigned_user_id as string);

      let assignedUsersMap: { [key: string]: Record<string, unknown> } = {};
      if (assignedUserIds.length > 0) {
        // If userMap is provided, use it instead of querying the database
        if (userMap) {
          assignedUsersMap = assignedUserIds.reduce((acc, userId) => {
            if (userMap[userId]) {
              acc[userId] = userMap[userId];
            }
            return acc;
          }, {} as { [key: string]: Record<string, unknown> });
        } else {
          // Use the same authenticated supabase client that was passed in
          if (!supabase) {
            return [];
          }

          // Try the same approach as auth system
          const { data: singleUserData, error: singleUserError } = await supabase
            .from('user_profiles')
            .select('id, name, email, image')
            .eq('id', assignedUserIds[0])
            .single();

          // Try the original approach
          const { data: usersData, error: usersError } = await supabase
            .from('user_profiles')
            .select('id, name, email, image')
            .in('id', assignedUserIds);

          // Prefer multiple user lookup (gets all users), fall back to single user lookup
          if (!usersError && usersData && usersData.length > 0) {
            const typedUsers = usersData as unknown as User[];
            assignedUsersMap = typedUsers.reduce((acc, user) => {
              acc[user.id] = user as Record<string, unknown>;
              return acc;
            }, {} as { [key: string]: Record<string, unknown> });
          } else if (!singleUserError && singleUserData) {
            assignedUsersMap[assignedUserIds[0]] = singleUserData as Record<string, unknown>;
          }
        }
      }

      // Get departments for each project via project_assignments
      const projectIds = typedProjects.map((p:any) => p.id);
      const departmentsByProject: { [key: string]: Record<string, unknown>[] } = {};

      // Fetch workflow steps for projects
      const workflowSteps: { [key: string]: string | null } = {};
      if (projectIds.length > 0) {
        const { data: workflowData, error: workflowError } = await supabase
          .from('workflow_instances')
          .select(`
            project_id,
            current_node_id,
            workflow_nodes!workflow_instances_current_node_id_fkey (
              label
            )
          `)
          .in('project_id', projectIds)
          .eq('status', 'active');

        type WorkflowInstance = {
          project_id: string;
          workflow_nodes?: {
            label: string;
          } | null;
        };

        if (!workflowError && workflowData) {
          const typedWorkflow = workflowData as unknown as WorkflowInstance[];
          typedWorkflow.forEach((instance:any) => {
            const nodes = instance.workflow_nodes;
            if (instance.project_id && nodes && typeof nodes.label === 'string') {
              workflowSteps[instance.project_id] = nodes.label;
            }
          });
        }
      }

      type ProjectAssignment = {
        project_id: string;
        user_id: string;
        user_roles?: {
          role_id: string;
          roles?: {
            department_id: string | null;
            departments?: {
              id: string;
              name: string;
            } | null;
          } | null;
        }[] | null;
      };

      if (projectIds.length > 0) {
        const { data: assignments, error: assignmentsError } = await supabase
          .from('project_assignments')
          .select(`
            project_id,
            user_id,
            user_roles!user_roles_user_id_fkey (
              role_id,
              roles!user_roles_role_id_fkey (
                department_id,
                departments!roles_department_id_fkey (
                  id,
                  name
                )
              )
            )
          `)
          .in('project_id', projectIds)
          .is('removed_at', null);

        if (!assignmentsError && assignments) {
          const typedAssignments = assignments as unknown as ProjectAssignment[];
          // Build a map of project_id -> unique departments
          typedAssignments.forEach((assignment:any) => {
            const projectId = assignment.project_id;
            if (!departmentsByProject[projectId]) {
              departmentsByProject[projectId] = [];
            }

            // Extract departments from user roles
            const userRoles = assignment.user_roles || [];
            userRoles.forEach((userRole: any) => {
              const role = userRole.roles;
              if (role && role.departments) {
                const dept = role.departments;
                // Check if department already exists for this project
                const exists = departmentsByProject[projectId].some((d:any) => d.id === dept.id);
                if (!exists) {
                  departmentsByProject[projectId].push(dept as Record<string, unknown>);
                }
              }
            });
          });
        }
      }

      const mappedProjects = typedProjects.map((project:any) => {
        const projectId = project.id;
        const assignedUserId = project.assigned_user_id;
        const assignedUsers = assignedUserId && assignedUsersMap[assignedUserId]
          ? [assignedUsersMap[assignedUserId]]
          : [];

        const status = project.status;
        return {
          ...project,
          departments: departmentsByProject[projectId] || [],
          assigned_users: assignedUsers,
          status_info: {
            id: status,
            name: getStatusDisplayName(status),
            color: getStatusColor(status)
          },
          workflow_step: workflowSteps[projectId] || null,
        } as ProjectWithDetails;
      });

      return mappedProjects;
    } catch {
      return [];
    }
  }

  // Get account metrics
  async getAccountMetrics(accountId: string, supabaseClient?: AppSupabaseClient | null): Promise<AccountMetrics> {
    try {
      const projects = await this.getAccountProjects(accountId, undefined, supabaseClient);
      const now = new Date();

      const activeProjects = projects.filter((p: any) =>
        p.status_info.name !== 'Complete' && p.status_info.name !== 'Cancelled'
      ).length;

      const completedProjects = projects.filter((p: any) =>
        p.status_info.name === 'Complete'
      ).length;

      const totalProjects = projects.length;

      // Upcoming deadlines - only count non-completed projects with deadlines in next 7 days
      const upcomingDeadlines = projects.filter((p: any) => {
        if (!p.end_date) return false;
        // IMPORTANT: Exclude completed projects from deadline counts
        if (p.status_info.name === 'Complete' || p.status_info.name === 'Cancelled') return false;
        const endDate = new Date(p.end_date);
        const daysUntilDeadline = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        return daysUntilDeadline > 0 && daysUntilDeadline <= 7;
      }).length;

      // Overdue projects - only count non-completed projects that are past due
      const overdueProjects = projects.filter((p: any) => {
        if (!p.end_date) return false;
        // IMPORTANT: Exclude completed projects from overdue counts
        if (p.status_info.name === 'Complete' || p.status_info.name === 'Cancelled') return false;
        const endDate = new Date(p.end_date);
        return endDate < now;
      }).length;

      // Count actual pending approvals from workflow instances for this account's projects
      let pendingApprovals = 0;
      if (supabaseClient && projects.length > 0) {
        const supabase = supabaseClient as any;
        const projectIds = projects.map((p: any) => p.id);

        // Query workflow instances for account's projects that are waiting on approval/form nodes
        const { data: workflowInstances, error: workflowError } = await supabase
          .from('workflow_instances')
          .select(`
            id,
            project_id,
            workflow_nodes!workflow_instances_current_node_id_fkey(node_type)
          `)
          .in('project_id', projectIds)
          .eq('status', 'active');

        if (!workflowError && workflowInstances) {
          type WorkflowInstanceWithNode = {
            workflow_nodes?: {
              node_type: string;
            } | null;
          };

          const typedInstances = workflowInstances as unknown as WorkflowInstanceWithNode[];
          // Count instances where current node is an approval or form type
          pendingApprovals = typedInstances.filter((instance:any) => {
            const nodes = instance.workflow_nodes;
            const nodeType = nodes?.node_type;
            return nodeType === 'approval' || nodeType === 'form';
          }).length;
        }
      }

      // Calculate health score based on various factors
      let healthScore = 100;
      if (overdueProjects > 0) healthScore -= overdueProjects * 20;
      if (upcomingDeadlines > 3) healthScore -= (upcomingDeadlines - 3) * 5;
      if (pendingApprovals > 3) healthScore -= (pendingApprovals - 3) * 10;
      healthScore = Math.max(0, healthScore);

      return {
        activeProjects,
        completedProjects,
        totalProjects,
        upcomingDeadlines,
        overdueProjects,
        pendingApprovals,
        healthScore,
      };
    } catch {
      return {
        activeProjects: 0,
        completedProjects: 0,
        totalProjects: 0,
        upcomingDeadlines: 0,
        overdueProjects: 0,
        pendingApprovals: 0,
        healthScore: 0,
      };
    }
  }

  // Get urgent items for an account
  async getUrgentItems(accountId: string, supabaseClient?: AppSupabaseClient | null): Promise<UrgentItem[]> {
    try {
      const projects = await this.getAccountProjects(accountId, undefined, supabaseClient);
      const now = new Date();
      const urgentItems: UrgentItem[] = [];

      projects.forEach((project: any) => {
        // Check for projects marked as URGENT priority
        if (project.priority === 'urgent' && project.status_info.name !== 'Complete') {
          urgentItems.push({
            id: `urgent-${project.id}`,
            type: 'project',
            title: `URGENT: ${project.name}`,
            description: project.description || 'High priority project requiring immediate attention',
            priority: 'high',
            dueDate: project.end_date ? new Date(project.end_date) : new Date(),
            projectId: project.id,
          });
        }

        // Check for overdue projects
        if (project.end_date) {
          const endDate = new Date(project.end_date);
          const daysOverdue = Math.ceil((now.getTime() - endDate.getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysOverdue > 0 && project.status_info.name !== 'Complete') {
            urgentItems.push({
              id: `overdue-${project.id}`,
              type: 'project',
              title: `Overdue: ${project.name}`,
              description: `Project is ${daysOverdue} days overdue`,
              priority: 'high',
              dueDate: endDate,
              projectId: project.id,
            });
          }
        }

        // Check for projects due soon
        if (project.end_date) {
          const endDate = new Date(project.end_date);
          const daysUntilDeadline = Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysUntilDeadline > 0 && daysUntilDeadline <= 3 && project.status_info.name !== 'Complete') {
            urgentItems.push({
              id: `due-soon-${project.id}`,
              type: 'project',
              title: `Due Soon: ${project.name}`,
              description: `Project due in ${daysUntilDeadline} days`,
              priority: daysUntilDeadline === 1 ? 'high' : 'medium',
              dueDate: endDate,
              projectId: project.id,
            });
          }
        }
      });

      // Sort by priority and due date
      return urgentItems.sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        }
        return a.dueDate.getTime() - b.dueDate.getTime();
      });
    } catch {
      return [];
    }
  }

}

// Export singleton instance
export const accountService = new AccountService();
