import { logger } from '@/lib/debug-logger';

export type ProjectIssue = {
  id: string;
  project_id: string;
  content: string;
  status: 'open' | 'in_progress' | 'resolved';
  created_by: string;
  created_at: string;
  updated_at: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
  user_profiles?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
  resolver_profiles?: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
};

export type ProjectIssueInput = {
  project_id: string;
  content: string;
};

// Issue lookups for the account and department pages, run on the server with the signed-in user's
// client (row-level security applies): /api/accounts/[id]/issues and /api/departments/[id]/issues.
// Single issues are read and changed through /api/projects/[projectId]/issues.
export const projectIssuesService = {
  /**
   * Get all active (open or in_progress) issues for a department
   */
  async getDepartmentActiveIssues(departmentId: string, db: any): Promise<(ProjectIssue & { project?: { id: string; name: string } })[]> {
    const supabase = db;
    
    // Get all roles for this department
    const { data: departmentRoles, error: rolesError } = await supabase
      .from('roles')
      .select('id')
      .eq('department_id', departmentId);

    if (rolesError) {
      logger.error('Error fetching department roles', {}, rolesError as Error);
      throw rolesError;
    }

    const roleIds = departmentRoles?.map((role: any) => role.id) || [];

    if (roleIds.length === 0) {
      return [];
    }

    // Get user IDs who have roles in this department
    const { data: usersInDept, error: userRolesError } = await supabase
      .from('user_roles')
      .select('user_id')
      .in('role_id', roleIds);

    if (userRolesError) {
      logger.error('Error fetching users for department', {}, userRolesError as Error);
      throw userRolesError;
    }

    const userIds = Array.from(new Set(usersInDept?.map((ur: any) => ur.user_id) || []));

    if (userIds.length === 0) {
      return [];
    }

    // Get project IDs where users from this department are assigned
    const { data: projectAssignments, error: assignmentsError } = await supabase
      .from('project_assignments')
      .select(`
        project_id,
        projects (
          id,
          name
        )
      `)
      .in('user_id', userIds)
      .is('removed_at', null);

    if (assignmentsError) {
      logger.error('Error fetching project assignments', {}, assignmentsError as Error);
      throw assignmentsError;
    }

    if (!projectAssignments || projectAssignments.length === 0) {
      return [];
    }

    // Extract unique projects
    const projectsMap = new Map();
    projectAssignments.forEach((assignment: any) => {
      if (assignment.projects && !projectsMap.has(assignment.projects.id)) {
        projectsMap.set(assignment.projects.id, assignment.projects);
      }
    });
    const projects = Array.from(projectsMap.values());
    const projectIds = projects.map((p: any) => p.id);

    if (projectIds.length === 0) {
      return [];
    }

    // Get all active issues for these projects
    const { data: issues, error: issuesError } = await supabase
      .from('project_issues')
      .select(`
        *,
        user_profiles:created_by(id, name, email, image),
        resolver_profiles:resolved_by(id, name, email, image)
      `)
      .in('project_id', projectIds)
      .in('status', ['open', 'in_progress'])
      .order('created_at', { ascending: false });

    if (issuesError) {
      logger.error('Error fetching department issues', {}, issuesError as Error);
      throw issuesError;
    }

    // Add project information to each issue
    const issuesWithProjects = (issues || []).map((issue: any) => {
      const project = projects.find((p: any) => p.id === issue.project_id);
      return {
        ...issue,
        project: project ? { id: project.id, name: project.name } : undefined
      };
    });

    return issuesWithProjects;
  },

  /**
   * Get all active (open or in_progress) issues for an account
   */
  async getAccountActiveIssues(accountId: string, db: any): Promise<(ProjectIssue & { project?: { id: string; name: string } })[]> {
    const supabase = db;
    
    // First, get all project IDs for this account
    const { data: projects, error: projectsError } = await supabase
      .from('projects')
      .select('id, name')
      .eq('account_id', accountId);

    if (projectsError) {
      logger.error('Error fetching projects', {}, projectsError as Error);
      throw projectsError;
    }

    if (!projects || projects.length === 0) {
      return [];
    }

    const projectIds = projects.map((p: any) => p.id);

    // Get all active issues for these projects
    const { data, error } = await supabase
      .from('project_issues')
      .select(`
        *,
        user_profiles:created_by(id, name, email, image),
        resolver_profiles:resolved_by(id, name, email, image)
      `)
      .in('project_id', projectIds)
      .in('status', ['open', 'in_progress'])
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching account issues', {}, error as Error);
      throw error;
    }

    // Add project info to each issue
    const issuesWithProjects = (data || []).map((issue: any) => ({
      ...issue,
      project: projects.find((p: any) => p.id === issue.project_id)
    }));

    return issuesWithProjects;
  },
};

