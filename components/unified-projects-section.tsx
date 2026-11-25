'use client';

import { toast } from 'sonner';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CheckCircle2,
  Clock,
  Loader2,
  FolderOpen,
  ExternalLink,
  AlertCircle,
  GitBranch,
  History,
  User
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { ProjectDataTable, ProjectTableData, ProjectStatus, ProjectPriority } from '@/components/project-data-table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { activeWorkflowInstances, deleteProject } from '@/lib/client-queries';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { useProjects } from '@/lib/hooks/use-data';
import { hasPermission, canViewProject } from '@/lib/rbac';
import { usePersistentState } from '@/lib/hooks/use-persistent-state';
import { Permission } from '@/lib/permissions';
import { UserWithRoles } from '@/lib/rbac-types';

interface WorkflowProject {
  id: string;
  name: string;
  description: string | null;
  account_id: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  workflow_instance_id: string | null;
  account?: {
    id: string;
    name: string;
  };
  assigned_by?: string;
  role_in_project?: string;
}

interface ApprovalRequest {
  id: string;
  workflow_instance_id: string;
  current_node_id: string;
  project_id: string;
  projects?: WorkflowProject;
  workflow_nodes?: {
    id: string;
    label: string;
    node_type: string;
  };
}

interface ProjectWithDetails {
  id: string;
  name: string;
  description: string | null;
  account_id: string;
  status: string;
  priority: string;
  start_date: string | null;
  end_date: string | null;
  estimated_hours: number | null;
  actual_hours: number;
  remaining_hours?: number | null;
  task_hours_sum?: number;
  created_by: string;
  assigned_user_id: string | null;
  created_at: string;
  updated_at: string;
  account?: {
    id: string;
    name: string;
  } | null;
  departments: Record<string, unknown>[];
  daysUntilDeadline?: number | null;
  workflow_step?: string | null;
  reopened_at?: string | null;
}

interface AssignedUser {
  id: string;
  name: string;
  email: string;
}

interface PipelineProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: string;
  account?: { id: string; name: string } | null;
  assigned_step: {
    nodeId: string;
    nodeName: string;
    nodeType: string;
  };
  assigned_at: string;
  workflow_instance_id: string;
  assigned_user?: AssignedUser;
}

interface PastProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: string;
  completed_at?: string;
  account?: { id: string; name: string } | null;
  completion_reason: 'project_completed' | 'step_completed';
  role_in_project?: string;
  completed_step?: {
    nodeId: string;
    nodeName: string;
    nodeType: string;
  };
  assigned_user?: AssignedUser;
}

interface UnifiedProjectsSectionProps {
  userProfile: UserWithRoles | null;
}

// Workflow inbox lists: an empty list when the request fails, so one failing list does not hide the others
const inboxList = (field: 'projects' | 'approvals') => async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) return [];
  const body = await res.json();
  return body?.success ? body[field] || [] : [];
};
const inboxProjects = inboxList('projects');
const inboxApprovals = inboxList('approvals');

// Which of the user's projects they may see (no check needed for those who see every project)
async function visibleFor(userProfile: UserWithRoles, projects: ProjectWithDetails[]): Promise<ProjectWithDetails[]> {
  if (projects.length === 0) return [];
  const [hasViewAllProjects, hasViewProjects] = await Promise.all([
    hasPermission(userProfile, Permission.VIEW_ALL_PROJECTS),
    hasPermission(userProfile, Permission.VIEW_PROJECTS)
  ]);
  if (hasViewAllProjects) return [...projects];
  if (!hasViewProjects) return [];
  const allowed = await Promise.all(projects.map((project) => canViewProject(userProfile, project.id).catch(() => false)));
  return projects.filter((_, index) => allowed[index]);
}

// Current workflow step label per project
async function workflowStepsFor(projectIds: string[]): Promise<{ [key: string]: string | null }> {
  if (projectIds.length === 0) return {};
  const { data: workflowData, error } = await activeWorkflowInstances(projectIds);
  const steps: { [key: string]: string | null } = {};
  if (error || !workflowData) return steps;
  workflowData.forEach((instance: any) => {
    if (!instance.project_id) return;
    let nodeLabel: string | null = null;
    // Strategy 1: the label from the snapshot (most reliable for modified workflows)
    const snapshot = instance.started_snapshot;
    if (snapshot?.nodes && Array.isArray(snapshot.nodes)) {
      const currentNode = snapshot.nodes.find((n: any) => n.id === instance.current_node_id);
      if (currentNode?.label) nodeLabel = currentNode.label;
    }
    // Strategy 2: the live workflow node (workflows without snapshots)
    if (!nodeLabel && instance.workflow_nodes?.label) nodeLabel = instance.workflow_nodes.label;
    // Strategy 3: a current node without a label
    if (!nodeLabel && instance.current_node_id) nodeLabel = 'Active Workflow';
    if (nodeLabel) steps[instance.project_id as string] = nodeLabel;
  });
  return steps;
}

export function UnifiedProjectsSection({ userProfile }: UnifiedProjectsSectionProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = usePersistentState('dashboard-projects:tab', 'projects');

  // Everything below is cached by SWR: returning to the page shows the last data at once and refreshes it
  // in the background; skeletons only appear when nothing has been loaded yet.
  const userId = (userProfile as any)?.id as string | undefined;
  const { projects: assignedProjects, isLoading: projectsLoading, error: projectsError, mutate: mutateProjects } = useProjects(userId, 100);
  const { data: pendingApprovals = [], isLoading: approvalsLoading } = useSWR<ApprovalRequest[]>('/api/workflows/my-approvals', inboxApprovals);
  const { data: pipelineProjects = [], isLoading: pipelineLoading } = useSWR<PipelineProject[]>('/api/workflows/my-pipeline', inboxProjects);
  const { data: pastProjects = [], isLoading: pastLoading } = useSWR<PastProject[]>('/api/workflows/my-past-projects', inboxProjects);
  const loading = approvalsLoading || pipelineLoading || pastLoading;

  // Filter projects based on permissions
  const projectIds = useMemo(
    () => assignedProjects.map((p: ProjectWithDetails) => p.id).join(','),
    [assignedProjects]
  );
  const { data: visibleData, mutate: mutateVisible } = useSWR(
    userProfile && !projectsLoading ? ['dashboard-visible-projects', userProfile.id, projectIds] : null,
    () => visibleFor(userProfile as UserWithRoles, assignedProjects),
    { keepPreviousData: true }
  );

  const visibleProjects: ProjectWithDetails[] = visibleData ?? [];
  const checkingAccess = !!userProfile && !projectsLoading && !projectsError && visibleData === undefined;

  // Workflow steps for visible projects
  const visibleIds = visibleProjects.map((p: ProjectWithDetails) => p.id).join(',');
  const { data: workflowSteps = {} } = useSWR(
    visibleIds ? ['dashboard-workflow-steps', visibleIds] : null,
    () => workflowStepsFor(visibleIds.split(',')),
    { keepPreviousData: true }
  );

  // Delete project state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<ProjectWithDetails | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);

  // Handle project deletion
  const handleDeleteProject = async () => {
    if (!projectToDelete || !userProfile) return;

    try {
      setDeletingProject(true);

      // Delete the project (the API checks the project-manager permission)
      const { error } = await deleteProject(projectToDelete.id);

      if (error) {
        throw error;
      }

      // Remove it from the list right away, then refresh the cached lists
      const deletedId = projectToDelete.id;
      void mutateVisible((prev) => (prev || []).filter((p: ProjectWithDetails) => p.id !== deletedId), { revalidate: false });
      void mutateProjects();

      // Close dialog and reset state
      setDeleteDialogOpen(false);
      setProjectToDelete(null);
    } catch {
      toast.error('Failed to delete project. Please try again.');
    } finally {
      setDeletingProject(false);
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'high':
        return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'medium':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'low':
        return 'bg-gray-100 text-gray-800 border-gray-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  // Transform projects to ProjectTableData format for the new table component
  const transformToTableData = (projects: ProjectWithDetails[]): ProjectTableData[] => {
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      workflowStep: project.workflow_step || undefined,
      priority: (project.priority || 'medium') as ProjectPriority,
      account: project.account?.name,
      accountId: project.account_id,
      hours: {
        estimated: project.estimated_hours || undefined,
        actual: project.actual_hours || 0,
        remaining: project.estimated_hours
          ? Math.max(0, project.estimated_hours - (project.actual_hours || 0))
          : undefined
      },
      deadline: project.end_date || undefined,
      assignedUsers: [], // This section doesn't have assigned users data
      status: (project.status || 'planning') as ProjectStatus
    }));
  };

  // Add workflow steps to visible projects
  const projectsWithWorkflowSteps = visibleProjects.map((project: any) => ({
    ...project,
    workflow_step: workflowSteps[project.id] || null
  }));

  if (loading || projectsLoading || checkingAccess) {
    return (
      <Card>
        <CardHeader>
          <div className="h-6 w-32 bg-muted rounded animate-pulse" />
          <div className="h-4 w-64 bg-muted/60 rounded animate-pulse mt-1" />
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            {[1,2,3,4].map(i => (
              <div key={i} className="h-8 w-28 bg-muted/50 rounded animate-pulse" />
            ))}
          </div>
          <div className="border rounded-lg overflow-hidden">
            <div className="grid grid-cols-7 gap-4 p-3 border-b bg-muted/30">
              {[1,2,3,4,5,6,7].map(i => (
                <div key={i} className="h-4 bg-muted rounded animate-pulse" />
              ))}
            </div>
            {[1,2,3].map(i => (
              <div key={i} className="grid grid-cols-7 gap-4 p-3 border-b last:border-0">
                {[1,2,3,4,5,6,7].map(j => (
                  <div key={j} className="h-4 bg-muted/40 rounded animate-pulse" />
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="w-5 h-5" />
          My Projects
        </CardTitle>
        <CardDescription>
          All projects assigned to you and pending approvals
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="projects" className="flex items-center gap-1 text-xs sm:text-sm" aria-label="My Projects">
              <Clock className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline" aria-hidden="true">My Projects</span>
              <span className="sm:hidden" aria-hidden="true">Projects</span>
              {visibleProjects.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1">
                  {visibleProjects.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="pipeline" className="flex items-center gap-1 text-xs sm:text-sm" aria-label="In the Pipeline">
              <GitBranch className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline" aria-hidden="true">In the Pipeline</span>
              <span className="sm:hidden" aria-hidden="true">Pipeline</span>
              {pipelineProjects.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1">
                  {pipelineProjects.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="approvals" className="flex items-center gap-1 text-xs sm:text-sm" aria-label="Pending Approvals">
              <CheckCircle2 className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline" aria-hidden="true">Pending Approvals</span>
              <span className="sm:hidden" aria-hidden="true">Approvals</span>
              {pendingApprovals.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1">
                  {pendingApprovals.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="past" className="flex items-center gap-1 text-xs sm:text-sm" aria-label="Completed">
              <History className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline" aria-hidden="true">Completed</span>
              <span className="sm:hidden" aria-hidden="true">Done</span>
              {pastProjects.filter((p: any) => p.completion_reason === 'project_completed').length > 0 && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1">
                  {pastProjects.filter((p: any) => p.completion_reason === 'project_completed').length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* My Projects Tab */}
          <TabsContent value="projects" className="space-y-4 mt-4">
            {/* Projects Table */}
            {projectsError ? (
              <div className="text-center py-8">
                <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">Error Loading Projects</h3>
                <p className="text-gray-600">
                  {projectsError.message || 'Failed to load projects. Please try again.'}
                </p>
              </div>
            ) : projectsWithWorkflowSteps.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <Clock className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">No projects assigned to you</p>
              </div>
            ) : (
              <ProjectDataTable
                projects={transformToTableData(projectsWithWorkflowSteps)}
                defaultVisibleColumns={['name', 'workflowStep', 'priority', 'account', 'hours', 'deadline', 'status']}
                onRowClick={(project) => router.push(`/projects/${project.id}`)}
              />
            )}
          </TabsContent>

          {/* Pending Approvals Tab */}
          <TabsContent value="approvals" className="space-y-4 mt-4">
            {pendingApprovals.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">No pending approval requests</p>
              </div>
            ) : (
              <div className="space-y-3">
                {pendingApprovals.map((approval, index: number) => (
                  <Card key={(approval as any).active_step_id || `${approval.id}-${index}`} className="border-l-4 border-l-yellow-400 hover:shadow-md transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <Link
                              href={`/projects/${approval.project_id}`}
                              className="font-semibold text-lg hover:text-blue-600 transition-colors"
                            >
                              {approval.projects?.name || 'Unnamed Project'}
                            </Link>
                            <Badge className="bg-yellow-100 text-yellow-800" aria-label="Status: Awaiting Approval">
                              Awaiting Approval
                            </Badge>
                            {approval.projects?.priority && (
                              <Badge className={getPriorityColor(approval.projects.priority)} aria-label={`Priority: ${approval.projects.priority}`}>
                                {approval.projects.priority}
                              </Badge>
                            )}
                          </div>
                          {approval.projects?.description && (
                            <p className="text-sm text-gray-600 mb-2 line-clamp-2">
                              {approval.projects.description}
                            </p>
                          )}
                          <div className="flex items-center flex-wrap gap-4 text-xs text-gray-500">
                            {(approval as any).assigned_user && (
                              <span className="flex items-center gap-1">
                                <User className="h-3 w-3" />
                                <span className="font-medium">Assigned to:</span>
                                {(approval as any).assigned_user.name}
                              </span>
                            )}
                            {approval.workflow_nodes?.label && (
                              <span className="flex items-center gap-1">
                                <span className="font-medium">Step:</span>
                                {approval.workflow_nodes.label}
                              </span>
                            )}
                            {approval.projects?.account && (
                              <span className="flex items-center gap-1">
                                <span className="font-medium">Account:</span>
                                {approval.projects.account.name}
                              </span>
                            )}
                          </div>
                        </div>
                        <Button size="sm" asChild>
                          <Link href={`/projects/${approval.project_id}`}>
                            Review & Approve
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* In the Pipeline Tab */}
          <TabsContent value="pipeline" className="space-y-4 mt-4">
            {pipelineProjects.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <GitBranch className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">No projects in your pipeline</p>
                <p className="text-xs text-gray-400 mt-1">
                  Projects will appear here when you&apos;re assigned to a future workflow step
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {pipelineProjects.map((project:any, index:any) => (
                  <Card key={`${project.id}-${project.assigned_user?.id || index}`} className="border-l-4 border-l-blue-400 hover:shadow-md transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <Link
                              href={`/projects/${project.id}`}
                              className="font-semibold text-lg hover:text-blue-600 transition-colors"
                            >
                              {project.name}
                            </Link>
                            <Badge className="bg-blue-100 text-blue-800 border-blue-300" aria-label={`Workflow step: ${project.assigned_step.nodeName}`}>
                              {project.assigned_step.nodeName}
                            </Badge>
                            {project.priority && (
                              <Badge className={getPriorityColor(project.priority)} aria-label={`Priority: ${project.priority}`}>
                                {project.priority}
                              </Badge>
                            )}
                          </div>
                          {project.description && (
                            <p className="text-sm text-gray-600 mb-2 line-clamp-2">
                              {project.description}
                            </p>
                          )}
                          <div className="flex items-center flex-wrap gap-4 text-xs text-gray-500">
                            {project.assigned_user && (
                              <span className="flex items-center gap-1">
                                <User className="h-3 w-3" />
                                <span className="font-medium">Assigned to:</span>
                                {project.assigned_user.name}
                              </span>
                            )}
                            {project.account && (
                              <span className="flex items-center gap-1">
                                <span className="font-medium">Account:</span>
                                {project.account.name}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <span className="font-medium">Assigned:</span>
                              {formatDistanceToNow(new Date(project.assigned_at), { addSuffix: true })}
                            </span>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/projects/${project.id}`}>
                            <ExternalLink className="h-4 w-4 mr-1" />
                            View
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Past Projects Tab - Shows completed projects only */}
          <TabsContent value="past" className="space-y-4 mt-4">
            {/* Project count */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">
                {pastProjects.filter((p: any) => p.completion_reason === 'project_completed').length} completed projects
              </span>
            </div>

            {pastProjects.filter((p: any) => p.completion_reason === 'project_completed').length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <History className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">No completed projects</p>
                <p className="text-xs text-gray-400 mt-1">
                  Completed projects will appear here
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {pastProjects
                  .filter((p: any) => p.completion_reason === 'project_completed')
                  .map((project:any, index:any) => (
                  <Card key={`${project.id}-${project.assigned_user?.id || index}`} className="border-l-4 hover:shadow-md transition-shadow border-l-green-400">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <Link
                              href={`/projects/${project.id}`}
                              className="font-semibold text-lg hover:text-blue-600 transition-colors"
                            >
                              {project.name}
                            </Link>
                            <Badge className="bg-green-100 text-green-800 border-green-300" aria-label="Status: Completed">
                              <CheckCircle2 className="w-3 h-3 mr-1" aria-hidden="true" />
                              Completed
                            </Badge>
                            {project.priority && (
                              <Badge className={getPriorityColor(project.priority)} aria-label={`Priority: ${project.priority}`}>
                                {project.priority}
                              </Badge>
                            )}
                          </div>
                          {project.description && (
                            <p className="text-sm text-gray-600 mb-2 line-clamp-2">
                              {project.description}
                            </p>
                          )}
                          <div className="flex items-center flex-wrap gap-4 text-xs text-gray-500">
                            {project.assigned_user && (
                              <span className="flex items-center gap-1">
                                <User className="h-3 w-3" />
                                <span className="font-medium">User:</span>
                                {project.assigned_user.name}
                              </span>
                            )}
                            {project.account && (
                              <span className="flex items-center gap-1">
                                <span className="font-medium">Account:</span>
                                {project.account.name}
                              </span>
                            )}
                            {project.completed_step && (
                              <span className="flex items-center gap-1">
                                <span className="font-medium">{project.assigned_user ? 'Step:' : 'Your Step:'}</span>
                                {project.completed_step.nodeName}
                              </span>
                            )}
                            {project.role_in_project && (
                              <span className="flex items-center gap-1">
                                <span className="font-medium">Role:</span>
                                {project.role_in_project}
                              </span>
                            )}
                            {project.completed_at && (
                              <span className="flex items-center gap-1">
                                <span className="font-medium">Completed:</span>
                                {formatDistanceToNow(new Date(project.completed_at), { addSuffix: true })}
                              </span>
                            )}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/projects/${project.id}`}>
                            <ExternalLink className="h-4 w-4 mr-1" />
                            View
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the project &quot;{projectToDelete?.name}&quot;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setProjectToDelete(null);
              }}
              disabled={deletingProject}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteProject}
              disabled={deletingProject}
            >
              {deletingProject ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
