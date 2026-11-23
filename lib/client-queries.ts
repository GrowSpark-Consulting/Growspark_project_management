'use client';
/**
 * Browser reads and writes that used to query the database directly (Phase 11). Each calls an API
 * endpoint and returns the same { data, error } shape the component used before, so the code around
 * the call stays the same. The endpoints run as the signed-in user, with row-level security.
 */
import { apiGet, apiSend } from './client-api';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Result<T> = { data: T | null; error: unknown; count?: number | null };

async function wrap<T>(request: Promise<{ data: T; meta?: { count?: number } }>): Promise<Result<T>> {
  try {
    const body = await request;
    return { data: body.data, error: null, count: body.meta?.count ?? null };
  } catch (error) {
    return { data: null, error, count: null };
  }
}

/** Long id lists are sent in chunks of 100 to keep URLs short. */
async function chunked(ids: string[], load: (part: string[]) => Promise<Result<any[]>>): Promise<Result<any[]>> {
  if (!ids.length) return { data: [], error: null };
  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await load(ids.slice(i, i + 100));
    if (r.error) return r;
    rows.push(...(r.data || []));
  }
  return { data: rows, error: null };
}

const qs = (params: Record<string, string | number | boolean | null | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();

/** Active workflow runs of these projects, with the current step's label and the run's snapshot. */
export const activeWorkflowInstances = (projectIds: string[]) =>
  chunked(projectIds, (part) => wrap(apiGet(`/api/workflows/active-instances?${qs({ projectIds: part.join(',') })}`)));

/** Each task's project and estimated hours, for these projects. */
export const taskHoursOfProjects = (projectIds: string[]) =>
  chunked(projectIds, (part) => wrap(apiGet(`/api/projects/task-hours?${qs({ projectIds: part.join(',') })}`)));

/** The signed-in user's time entries (with task and project), and the total count for paging. */
export const myTimeEntries = (p: { from?: string; to?: string; projectId?: string; taskId?: string; sort?: string; order?: 'asc' | 'desc'; offset?: number; limit?: number }) =>
  wrap<any[]>(apiGet(`/api/me/time-entries?${qs(p)}`));

/** Projects and tasks the signed-in user has logged time on (raw rows, as the filters used them). */
export const myTimeEntryFilters = () => wrap<{ projects: any[]; tasks: any[] }>(apiGet('/api/me/time-entries?view=filters'));

/** The rows behind the time summary cards (dates from the browser's own time zone). */
export const myTimeEntrySummary = (d: { weekFrom: string; weekTo: string; monthFrom: string; monthTo: string; since: string }) =>
  wrap<{ week: any[]; month: any[]; recent: any[]; count: number }>(apiGet(`/api/me/time-entries?${qs({ view: 'summary', ...d })}`));

/** The signed-in user's project assignments (with status) and the projects of their assigned tasks. */
export const myTimeOptions = () => wrap<{ assignments: any[]; taskProjects: any[] }>(apiGet('/api/me/time-options'));

/** Tasks of these projects by name (openOnly leaves out done tasks). */
export const tasksOfProjects = (projectIds: string[], openOnly = false) =>
  chunked(projectIds, (part) => wrap(apiGet(`/api/me/time-options?${qs({ view: 'tasks', projectIds: part.join(','), openOnly })}`)));

/** A project's tasks by name (id, name, status), optionally without one task. */
export const projectTasks = (projectId: string, exclude?: string) =>
  wrap<any[]>(apiGet(`/api/projects/${projectId}/tasks?${qs({ exclude })}`));

/** The name the breadcrumb shows for a project (with its account), an account or a department. */
export const breadcrumbName = (type: 'project' | 'account' | 'department', id: string) =>
  wrap<{ name: string; accountId?: string | null; accountName?: string | null } | null>(apiGet(`/api/breadcrumb?${qs({ type, id })}`));

/** Set a project's remaining hours (row-level security decides who may). */
export const setRemainingHours = (projectId: string, hours: number) =>
  wrap(apiSend(`/api/projects/${projectId}/remaining-hours`, 'PATCH', { remaining_hours: hours }));

/** Delete a project (the API checks the project-manager permission). */
export const deleteProject = (projectId: string) => wrap(apiSend(`/api/projects/${projectId}`, 'DELETE'));

/** The create-project dialogs: accounts and active workflows to pick from, and creating the project. */
export const newProjectOptions = () => wrap<{ accounts: any[] | null; workflows: any[] | null }>(apiGet('/api/projects/new'));
export const createProjectFromDialog = (p: {
  name: string; description?: string | null; accountId: string; priority: string;
  startDate?: string | null; endDate?: string | null; estimatedHours?: number | null; assignToMe?: boolean;
}) => wrap<any>(apiSend('/api/projects/new', 'POST', p));

/** Update a project's name, priority, dates or estimate (the API checks who may edit the project). */
export const updateProjectBasics = (projectId: string, fields: Record<string, unknown>) =>
  wrap<any>(apiSend(`/api/projects/${projectId}`, 'PUT', fields).then((b) => ({ data: b?.project ?? null })));

/** The project team with role names, for picking a task's assignee. */
export const assignablePeople = (projectId: string) => wrap<any[]>(apiGet(`/api/projects/${projectId}/assignable-people`));

/** What the workflow progress, timeline and diagram views load for a run. */
export const workflowViewData = (instanceId: string) =>
  wrap<{ instance: any; liveNodes: any[] | null; liveConnections: any[] | null; activeSteps: any[] | null; history: any[] | null }>(
    apiGet(`/api/workflows/instances/${instanceId}/view-data`));

/** The workflow progress dialog's lookups (see lib/workflow-progress-data.ts). */
export const workflowProgress = (instanceId: string, p: { view: 'access' | 'data'; activeStepId?: string; projectId?: string; branchId?: string }) =>
  wrap<any>(apiGet(`/api/workflows/instances/${instanceId}/progress-data?${qs(p)}`));

/** The project page's lookups (see /api/projects/[projectId]/page-data for the views). */
export const projectPageData = (projectId: string, view: 'overview' | 'status' | 'workflow-step' | 'tasks' | 'latest-run' | 'contributors' | 'people' | 'form-data', instanceId?: string) =>
  wrap<any>(apiGet(`/api/projects/${projectId}/page-data?${qs({ view, instanceId })}`));

/** Set a project's estimated hours (the API checks who may edit the project). */
export const setProjectEstimatedHours = (projectId: string, hours: number) =>
  wrap(apiSend(`/api/projects/${projectId}`, 'PUT', { estimated_hours: hours }));

/** Delete a task (the API checks the permission). */
export const deleteTask = (taskId: string) => wrap(apiSend(`/api/tasks/${taskId}`, 'DELETE'));

/** The Projects page list: open projects the user can see, with departments, workflow step and team. */
export const projectsList = () => wrap<any[]>(apiGet('/api/projects/list'));

/** Change a project's status (the API checks who may edit the project). */
export const setProjectStatus = (projectId: string, status: string) =>
  wrap(apiSend(`/api/projects/${projectId}`, 'PUT', { status }));

/** Open and in-progress issues of an account's projects, or of the projects a department works on. */
export const accountIssues = (accountId: string) => wrap<any[]>(apiGet(`/api/accounts/${accountId}/issues`));
export const departmentIssues = (departmentId: string) => wrap<any[]>(apiGet(`/api/departments/${departmentId}/issues`));

/** An account's completed projects, newest first. */
export const finishedAccountProjects = (accountId: string) => wrap<any[]>(apiGet(`/api/accounts/${accountId}/finished-projects`));

/** People and projects for the admin time-tracking filters. */
export const timeTrackingFilters = () => wrap<{ users: any[] | null; projects: any[] | null }>(apiGet('/api/admin/time-tracking/filters'));

/** The department admin tabs' data: roles with head counts, everyone's roles, and the department. */
export const departmentAdminData = (departmentId: string) =>
  wrap<{ roles: any[] | null; users: any[] | null; department: any }>(apiGet(`/api/departments/${departmentId}`));

/** Department changes: name and description, delete, create (the API checks the permission). */
export const saveDepartment = (departmentId: string, d: { name: string; description?: string | null }) =>
  wrap<any>(apiSend(`/api/departments/${departmentId}`, 'PATCH', d));
export const removeDepartment = (departmentId: string) => wrap(apiSend(`/api/departments/${departmentId}`, 'DELETE'));
export const createDepartment = (d: { name: string; description?: string | null }) =>
  wrap<any>(apiSend('/api/departments', 'POST', d).then((row) => ({ data: row })));

/** Add a role to a department, or rename one / change its permissions. */
export const createDepartmentRole = (departmentId: string, r: { name: string; permissions: Record<string, boolean> }) =>
  wrap<any>(apiSend(`/api/departments/${departmentId}/roles`, 'POST', r));
export const updateDepartmentRole = (departmentId: string, r: { roleId: string; name: string; permissions: Record<string, boolean> }) =>
  wrap<any>(apiSend(`/api/departments/${departmentId}/roles`, 'PATCH', r));

/** Org chart data: departments with roles, the role hierarchy, or the people holding one role. */
export const orgChart = (view: 'structure' | 'hierarchy' | 'role-users', roleId?: string) =>
  wrap<any>(apiGet(`/api/org-structure/chart?${qs({ view, roleId })}`));

/** A role with its details and its people. */
export const roleDetails = (roleId: string) => wrap<{ role: any; users: any[] }>(apiGet(`/api/roles/${roleId}`));

/** Update a role's name, description or permissions (needs the manage-roles permission). */
export const updateRole = (roleId: string, updates: Record<string, unknown>) =>
  wrap<any>(apiSend(`/api/roles/${roleId}`, 'PATCH', updates).then((b) => ({ data: b?.role ?? null })));

/** Take a role away from someone (needs the manage-roles permission). */
export const removeUserFromRole = (roleId: string, userId: string) =>
  wrap(apiSend(`/api/roles/${roleId}/remove-user/${userId}`, 'DELETE').then((b) => ({ data: b ?? true })));

/** An account's saved Kanban columns, or null when none are saved (the page then uses the defaults). */
export const accountKanbanColumns = (accountId: string) =>
  wrap<any[] | null>(apiGet(`/api/accounts/${accountId}/kanban-config`).then((b) => ({ data: b?.config?.columns ?? null })));

/** The milestones on the account timeline, and adding one. */
export const timelineMilestones = () => wrap<any[]>(apiGet('/api/milestones'));
export const addTimelineMilestone = (m: { name: string; description?: string; date: string; color?: string }) =>
  wrap<any>(apiSend('/api/milestones', 'POST', m));
