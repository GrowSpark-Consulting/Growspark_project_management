'use client'

import { toast } from 'sonner';
import { useAuth } from '@/lib/hooks/useAuth'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RoleGuard } from '@/components/role-guard'
import { projectsList, deleteProject } from '@/lib/client-queries'
import { FolderOpen, Plus } from 'lucide-react'
import ProjectCreationDialog from '@/components/project-creation-dialog'
import { ProjectDataTable, ProjectTableData, ProjectStatus, ProjectPriority } from '@/components/project-data-table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useRouter } from 'next/navigation'
import { hasPermission, canViewProject, isSuperadmin } from '@/lib/rbac'
import { Permission } from '@/lib/permissions'

type Project = any
type Account = any
type Department = any

interface AssignedUserData {
  id: string
  name: string
  email?: string
  image?: string
}

interface ProjectWithDetails extends Project {
  account: Account
  departments: Department[]
  workflow_step?: string | null  // Current workflow step name
  assigned_users?: AssignedUserData[]  // Users assigned to this project
}


export default function ProjectsPage() {
  const { userProfile } = useAuth()
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectWithDetails[]>([])
  const [visibleProjects, setVisibleProjects] = useState<ProjectWithDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [departmentFilter, setDepartmentFilter] = useState<string>('all')
  const [allDepartments, setAllDepartments] = useState<Department[]>([])
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<ProjectWithDetails | null>(null)
  const [deletingProject, setDeletingProject] = useState(false)
  const [canCreateProject, setCanCreateProject] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Cleanup refresh timeout on unmount
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current)
    }
  }, [])

  // Handle project creation - simple optimistic update
  const handleProjectCreated = useCallback((newProject: any) => {
    if (newProject) {
      const projectWithDetails = {
        ...newProject,
        account: (newProject.account || {
          id: newProject.account_id as string,
          name: 'Loading...',
          description: null,
          primary_contact_email: null,
          primary_contact_name: null,
          account_manager_id: null,
          service_tier: null,
          status: 'active',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }) as Account,
        departments: [],
        workflow_step: null,
      } as unknown as ProjectWithDetails
      // Add directly to visibleProjects for immediate visibility
      setVisibleProjects(prev => [projectWithDetails, ...prev])
    }
    // Trigger background refresh after 500ms to get complete data
    if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current)
    refreshTimeoutRef.current = setTimeout(() => {
      setRefreshKey(prev => prev + 1)
    }, 500)
  }, [])

  // Check create project permission (using consolidated MANAGE_PROJECTS)
  useEffect(() => {
    if (!userProfile) return;
    hasPermission(userProfile, Permission.MANAGE_PROJECTS).then(setCanCreateProject);
  }, [userProfile]);

  useEffect(() => {
    let cancelled = false

    const loadProjects = async () => {
      if (!userProfile) return

      try {
        setLoading(true)
        // Projects the user can see, with departments, workflow step and team (runs on the server as the user)
        const { data: list, error: listError } = await projectsList()
        if (listError) throw listError
        const projectsWithDetails = (list || []) as unknown as ProjectWithDetails[]

        if (cancelled) return

        setProjects(projectsWithDetails)

        // Extract unique departments from all projects for the filter dropdown
        const departmentsMap = new Map<string, Department>()
        projectsWithDetails.forEach((project: any) => {
          project.departments.forEach((dept: any) => {
            if (!departmentsMap.has(dept.id)) {
              departmentsMap.set(dept.id, dept)
            }
          })
        })
        setAllDepartments(Array.from(departmentsMap.values()).sort((a, b) => a.name.localeCompare(b.name)))
      } catch (err: unknown) {
        if (!cancelled) setError('Failed to load projects')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadProjects()

    return () => {
      cancelled = true
    }
  }, [userProfile, refreshKey])

  // Filter projects based on permissions - ONLY runs on login or explicit refresh
  // This prevents race conditions with optimistic updates
  const filterProjects = useCallback(async () => {
    const hasViewAllProjects = await hasPermission(userProfile, Permission.VIEW_ALL_PROJECTS)

    if (hasViewAllProjects) {
      setVisibleProjects(projects)
      return
    }

    const hasViewProjects = await hasPermission(userProfile, Permission.VIEW_PROJECTS)
    if (!hasViewProjects) {
      setVisibleProjects([])
      return
    }

    // Check all project access in parallel (not sequential)
    const accessChecks = await Promise.all(
      projects.map(async (project) => {
        const canView = await canViewProject(userProfile, project.id)
        return canView ? project : null
      })
    )
    setVisibleProjects(accessChecks.filter(Boolean) as ProjectWithDetails[])
  }, [userProfile, projects])

  useEffect(() => {
    if (!userProfile || loading) return

    if (projects.length === 0) {
      setVisibleProjects([])
      return
    }

    filterProjects()
  }, [userProfile, refreshKey, loading, projects, filterProjects])

  // Status colors removed - projects now use workflow steps

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
        estimated: project.estimated_hours,
        actual: project.actual_hours,
        remaining: project.remaining_hours
      },
      deadline: project.end_date,
      assignedUsers: (project.assigned_users || []).map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image
      })),
      status: (project.status || 'planning') as ProjectStatus
    }))
  }

  // Check if user can delete a project
  const canDeleteProject = async (project: ProjectWithDetails): Promise<boolean> => {
    if (!userProfile) return false

    // Check if user has MANAGE_ALL_PROJECTS permission (override for all projects)
    const hasDeleteAll = await hasPermission(userProfile, Permission.MANAGE_ALL_PROJECTS)
    if (hasDeleteAll) return true

    // Check if user has MANAGE_PROJECTS permission (consolidated from DELETE_PROJECT)
    const hasManage = await hasPermission(userProfile, Permission.MANAGE_PROJECTS)
    if (!hasManage) return false

    // If user has MANAGE_PROJECTS, check if they have access to this project
    // (they should, since it's in their visible projects list)
    return visibleProjects.some((p: any) => p.id === project.id)
  }

  // Handle project deletion
  const handleDeleteProject = async () => {
    if (!projectToDelete || !userProfile) return

    try {
      setDeletingProject(true)

      // Double-check permissions
      const canDelete = await canDeleteProject(projectToDelete)
      if (!canDelete) {
        toast.error('You do not have permission to delete this project')
        return
      }

      // Delete the project (the API checks the permission again)
      const { error } = await deleteProject(projectToDelete.id)

      if (error) {
        throw error
      }

      // Update local state to remove the deleted project
      setProjects(projects.filter((p: any) => p.id !== projectToDelete.id))
      setVisibleProjects(visibleProjects.filter((p: any) => p.id !== projectToDelete.id))

      // Close dialog and reset state
      setDeleteDialogOpen(false)
      setProjectToDelete(null)
    } catch (error: unknown) {
      toast.error('Failed to delete project. Please try again.')
    } finally {
      setDeletingProject(false)
    }
  }

  // Filter projects by department (use visibleProjects which are already permission-filtered)
  const filteredProjects = visibleProjects
    .filter((project: any) => {
      if (departmentFilter !== 'all' && !project.departments.some((dept: any) => dept.id === departmentFilter)) return false
      return true
    })

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-2 text-gray-600">Loading projects...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">Error</h1>
          <p className="text-gray-600 mt-2">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <RoleGuard>
      <div className="container mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
            <p className="text-gray-600 mt-1">
              View and manage all projects
            </p>
          </div>
          {canCreateProject && (
            <ProjectCreationDialog
              onProjectCreated={handleProjectCreated}
            >
              <Button data-tutorial="create-project">
                <Plus className="w-4 h-4 mr-2" />
                Create Project
              </Button>
            </ProjectCreationDialog>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5" />
              Project Management
            </CardTitle>
            <CardDescription>
              All projects you have access to
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
                {visibleProjects.length === 0 ? (
                  <div className="text-center py-12 text-gray-500">
                    <FolderOpen className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">No Projects Found</h3>
                    <p className="text-sm">You don&apos;t have access to any projects yet, or no projects have been created.</p>
                  </div>
                ) : (
                  <>
                    {/* Department Filter */}
                    {allDepartments.length > 0 && (
                      <div className="mb-4">
                        <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
                          <SelectTrigger className="w-[200px]">
                            <SelectValue placeholder="Filter by Department" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Departments</SelectItem>
                            {allDepartments.map((dept: any) => (
                              <SelectItem key={dept.id} value={dept.id}>
                                {dept.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Projects Table */}
                    <ProjectDataTable
                      projects={transformToTableData(filteredProjects)}
                      defaultVisibleColumns={['name', 'workflowStep', 'priority', 'account', 'hours', 'deadline', 'assignedUsers', 'status']}
                      onRowClick={(project) => router.push(`/projects/${project.id}`)}
                    />
                  </>
                )}
            </div>
          </CardContent>
        </Card>
      </div>

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
                setDeleteDialogOpen(false)
                setProjectToDelete(null)
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
    </RoleGuard>
  )
}
