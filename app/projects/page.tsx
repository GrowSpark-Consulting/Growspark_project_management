'use client'

import { toast } from 'sonner';
import { useAuth } from '@/lib/hooks/useAuth'
import { useState, useEffect, useCallback } from 'react'
import useSWR from 'swr'
import { useListParams } from '@/lib/hooks/use-list-params'
import { PaginationBar } from '@/components/ui/pagination-bar'
import { Input } from '@/components/ui/input'
import { apiGet } from '@/lib/client-api'
import type { PageInfo } from '@/lib/pagination'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RoleGuard } from '@/components/role-guard'
import { deleteProject } from '@/lib/client-queries'
import { FolderOpen, Plus, Search } from 'lucide-react'
import ProjectCreationDialog from '@/components/project-creation-dialog'
import { ProjectDataTable, ProjectTableData, ProjectStatus, ProjectPriority, type TableSort, type SortableColumn } from '@/components/project-data-table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useRouter } from 'next/navigation'
import { hasPermission } from '@/lib/rbac'
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


type ProjectsPage = { data: ProjectWithDetails[]; meta: { pagination: PageInfo; departments: Department[] } }

export default function ProjectsPage() {
  const { userProfile } = useAuth()
  const router = useRouter()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<ProjectWithDetails | null>(null)
  const [deletingProject, setDeletingProject] = useState(false)
  const [canCreateProject, setCanCreateProject] = useState(false)

  // Search, department, sort and page live in the URL; the server filters, sorts and pages
  // (access is checked there too, once, instead of once per project in the browser)
  const list = useListParams('projects', { q: '', department: '', sort: '', order: '' })
  const [searchInput, setSearchInput] = useState(list.values.q)
  useEffect(() => { setSearchInput(list.values.q) }, [list.values.q])
  useEffect(() => {
    if (searchInput === list.values.q) return
    const timer = setTimeout(() => list.update({ q: searchInput.trim() }), 350)
    return () => clearTimeout(timer)
  }, [searchInput, list])

  const userId = (userProfile as any)?.id as string | undefined
  const { data: pageData, error: loadError, isValidating, mutate: mutateProjects } = useSWR<ProjectsPage>(
    userId ? `/api/projects/list?${list.apiQuery}` : null,
    (url: string) => apiGet<ProjectsPage>(url),
    { keepPreviousData: true }
  )
  const visibleProjects: ProjectWithDetails[] = pageData?.data ?? []
  const allDepartments: Department[] = pageData?.meta?.departments ?? []
  const departmentFilter = list.values.department || 'all'
  const loading = !userProfile || (!loadError && pageData === undefined)
  const error = loadError ? 'Failed to load projects' : null
  const filtering = !!(list.values.q || list.values.department)
  const tableSort: TableSort = {
    column: (list.values.sort || null) as SortableColumn | null,
    direction: list.values.sort ? (list.values.order === 'desc' ? 'desc' : 'asc') : null,
  }
  const setDepartmentFilter = (value: string) => list.update({ department: value === 'all' ? '' : value })
  const setTableSort = (next: TableSort) => list.update({ sort: next.column || '', order: next.column && next.direction === 'desc' ? 'desc' : '' })

  // Handle project creation: show it at once, then refresh the list for its complete data
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
      void mutateProjects((prev) => prev ? { ...prev, data: [projectWithDetails, ...prev.data] } : prev, { revalidate: false })
    }
    void mutateProjects()
  }, [mutateProjects])

  // Check create project permission (using consolidated MANAGE_PROJECTS)
  useEffect(() => {
    if (!userProfile) return;
    hasPermission(userProfile, Permission.MANAGE_PROJECTS).then(setCanCreateProject);
  }, [userProfile]);

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

      // Remove it from the list right away, then refresh the page from the server
      const deletedId = projectToDelete.id
      void mutateProjects((prev) => prev ? { ...prev, data: prev.data.filter((p: any) => p.id !== deletedId) } : prev, { revalidate: false })
      void mutateProjects()

      // Close dialog and reset state
      setDeleteDialogOpen(false)
      setProjectToDelete(null)
    } catch (error: unknown) {
      toast.error('Failed to delete project. Please try again.')
    } finally {
      setDeletingProject(false)
    }
  }

  // The server already applied access, search and the department filter
  const filteredProjects = visibleProjects

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
                {/* Search and department filter (server-side) */}
                {(visibleProjects.length > 0 || filtering) && (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="relative w-full sm:w-72">
                      <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        placeholder="Search projects"
                        aria-label="Search projects"
                        className="pl-8"
                      />
                    </div>
                    {allDepartments.length > 0 && (
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
                    )}
                  </div>
                )}

                {visibleProjects.length === 0 ? (
                  <div className="text-center py-12 text-gray-500">
                    <FolderOpen className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    {filtering ? (
                      <>
                        <h3 className="text-lg font-medium text-gray-900 mb-2">No matching projects</h3>
                        <p className="text-sm">Try another search or department.</p>
                      </>
                    ) : (
                      <>
                        <h3 className="text-lg font-medium text-gray-900 mb-2">No Projects Found</h3>
                        <p className="text-sm">You don&apos;t have access to any projects yet, or no projects have been created.</p>
                      </>
                    )}
                  </div>
                ) : (
                  <ProjectDataTable
                    projects={transformToTableData(filteredProjects)}
                    defaultVisibleColumns={['name', 'workflowStep', 'priority', 'account', 'hours', 'deadline', 'assignedUsers', 'status']}
                    onRowClick={(project) => router.push(`/projects/${project.id}`)}
                    sort={tableSort}
                    onSortChange={setTableSort}
                  />
                )}

                <PaginationBar
                  pagination={pageData?.meta?.pagination}
                  onPageChange={list.setPage}
                  onPageSizeChange={list.setPageSize}
                  loading={isValidating && !!pageData}
                  itemLabel="projects"
                />
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
