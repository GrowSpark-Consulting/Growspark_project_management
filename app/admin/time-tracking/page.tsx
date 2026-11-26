'use client'

import { useState, useEffect, useCallback } from 'react'
import useSWR from 'swr'
import { useListParams } from '@/lib/hooks/use-list-params'
import { PaginationBar } from '@/components/ui/pagination-bar'
import type { PageInfo } from '@/lib/pagination'
import { useAuth } from '@/lib/hooks/useAuth'
import { timeTrackingFilters } from '@/lib/client-queries'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Clock, Download, Filter, AlertTriangle, Edit, Trash2 } from 'lucide-react'
import { hasPermission } from '@/lib/permission-checker'
import { Permission } from '@/lib/permissions'
import { toast } from 'sonner'

interface TimeEntry {
  id: string
  hours_logged: number
  entry_date: string
  description: string | null
  clock_in_time: string | null
  clock_out_time: string | null
  is_auto_clock_out: boolean
  created_at: string
  user: {
    id: string
    name: string
    email: string
  }
  project: {
    id: string
    name: string
  } | null
  task: {
    id: string
    name: string
  } | null
}

interface Summary {
  totalEntries: number
  totalHours: number
  uniqueUsers: number
  uniqueProjects: number
  autoClockOuts: number
}

export default function AdminTimeTrackingPage() {
  const { userProfile } = useAuth()
  const [checkingAccess, setCheckingAccess] = useState(true)
  const [hasAccess, setHasAccess] = useState(false)

  // Filters and page live in the URL (?startDate=&endDate=&userId=&page=&pageSize=)
  const list = useListParams('admin-time-tracking', { startDate: '', endDate: '', userId: '' })
  const [startDate, setStartDate] = useState(list.values.startDate)
  const [endDate, setEndDate] = useState(list.values.endDate)
  const [selectedUser, setSelectedUser] = useState(list.values.userId)
  useEffect(() => {
    setStartDate(list.values.startDate)
    setEndDate(list.values.endDate)
    setSelectedUser(list.values.userId)
  }, [list.values.startDate, list.values.endDate, list.values.userId])
  const [users, setUsers] = useState<{ id: string; name: string }[]>([])
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])

  // One page of entries plus totals over every matching entry (server-side)
  const { data: pageData, isLoading, isValidating, mutate: reloadEntries } = useSWR<{ success: boolean; timeEntries: TimeEntry[]; summary: Summary; pagination: PageInfo; error?: string }>(
    hasAccess ? `/api/admin/time-entries?${list.apiQuery}` : null,
    async (url: string) => {
      const response = await fetch(url)
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.success) throw new Error(body.error || 'Failed to load time entries')
      return body
    },
    { keepPreviousData: true, onError: () => toast.error('Failed to load time entries') }
  )
  const timeEntries = pageData?.timeEntries ?? []
  const summary = pageData?.summary ?? null
  const loading = isLoading && !pageData
  const loadTimeEntries = useCallback(() => { void reloadEntries() }, [reloadEntries])

  // Edit dialog state
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
  const [editHours, setEditHours] = useState('')
  const [editProject, setEditProject] = useState('none')
  const [editDescription, setEditDescription] = useState('')
  const [saving, setSaving] = useState(false)

  // Delete dialog state
  const [deletingEntry, setDeletingEntry] = useState<TimeEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadUsers = useCallback(async () => {
    try {
      const { data: filters, error } = await timeTrackingFilters()
      const data = filters?.users
      if (error || !data) {
        return
      }

      if (data) {
        setUsers(data)
      }
    } catch (error: unknown) {
      // Silent - filter data load failure is non-critical
    }
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const { data: filters, error } = await timeTrackingFilters()
      const data = filters?.projects
      if (error || !data) {
        return
      }

      if (data) {
        setProjects(data)
      }
    } catch (error: unknown) {
      // Silent - filter data load failure is non-critical
    }
  }, [])

  // Check permissions - Phase 9: VIEW_TEAM_TIME_ENTRIES → VIEW_ALL_TIME_ENTRIES
  useEffect(() => {
    const checkAccess = async () => {
      if (userProfile) {
        const canView = await hasPermission(userProfile, Permission.VIEW_ALL_TIME_ENTRIES)
        setHasAccess(canView)
        setCheckingAccess(false)
        if (canView) {
          loadUsers()
          loadProjects()
        }
      }
    }
    checkAccess()
  }, [userProfile, loadUsers, loadProjects])

  // Apply filters (back to page 1)
  const handleApplyFilters = () => {
    list.update({ startDate, endDate, userId: selectedUser === 'all' ? '' : selectedUser })
  }

  // Clear filters
  const handleClearFilters = () => {
    setStartDate('')
    setEndDate('')
    setSelectedUser('')
    list.update({ startDate: '', endDate: '', userId: '' })
  }

  // Format time
  const formatTime = (timeStr: string | null) => {
    if (!timeStr) return '-'
    return new Date(timeStr).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // Format date — parse date-only strings as local to avoid UTC off-by-one
  const formatDate = (dateStr: string) => {
    let date: Date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-').map(Number);
      date = new Date(year, month - 1, day);
    } else {
      date = new Date(dateStr);
    }
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })
  }

  // Export to CSV: every entry matching the filters, not just the page on screen
  const exportToCSV = async () => {
    const params = new URLSearchParams()
    if (list.values.startDate) params.set('startDate', list.values.startDate)
    if (list.values.endDate) params.set('endDate', list.values.endDate)
    if (list.values.userId) params.set('userId', list.values.userId)
    const response = await fetch(`/api/admin/time-entries?${params.toString()}`)
    const body = await response.json().catch(() => ({}))
    if (!response.ok || !body.success) {
      toast.error('Failed to export time entries')
      return
    }
    const allEntries: TimeEntry[] = body.timeEntries || []
    const headers = ['Date', 'User', 'Project', 'Task', 'Hours', 'Clock In', 'Clock Out', 'Auto Clock Out', 'Description']
    const rows = allEntries.map((entry: any) => [
      entry.entry_date,
      entry.user?.name || 'Unknown',
      entry.project?.name || 'N/A',
      entry.task?.name || 'N/A',
      entry.hours_logged.toFixed(2),
      entry.clock_in_time ? new Date(entry.clock_in_time).toISOString() : '',
      entry.clock_out_time ? new Date(entry.clock_out_time).toISOString() : '',
      entry.is_auto_clock_out ? 'Yes' : 'No',
      entry.description || ''
    ])

    const csv = [headers, ...rows].map((row: any) => row.map((cell: any) => `"${cell}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `time-entries-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Open edit dialog
  const handleEditEntry = (entry: TimeEntry) => {
    setEditingEntry(entry)
    setEditHours(entry.hours_logged.toString())
    setEditProject(entry.project?.id || 'none')
    setEditDescription(entry.description || '')
  }

  // Save edited entry
  const handleSaveEdit = async () => {
    if (!editingEntry) return

    setSaving(true)
    try {
      const response = await fetch(`/api/admin/time-entries/${editingEntry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hours_logged: parseFloat(editHours),
          project_id: editProject === 'none' ? null : editProject || null,
          description: editDescription || null,
        }),
      })

      if (!response.ok) {
        toast.error('Failed to update time entry')
        return
      }
      const data = await response.json()

      if (data.success) {
        toast.success('Time entry updated successfully')
        setEditingEntry(null)
        loadTimeEntries()
      } else {
        toast.error('Failed to update time entry')
      }
    } catch (error: unknown) {
      toast.error('Failed to update time entry')
    } finally {
      setSaving(false)
    }
  }

  // Delete time entry
  const handleDeleteEntry = async () => {
    if (!deletingEntry) return

    setDeleting(true)
    try {
      const response = await fetch(`/api/admin/time-entries/${deletingEntry.id}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        toast.error('Failed to delete time entry')
        return
      }
      const data = await response.json()

      if (data.success) {
        toast.success('Time entry deleted successfully')
        setDeletingEntry(null)
        loadTimeEntries()
      } else {
        toast.error(data.error || 'Failed to delete time entry')
      }
    } catch (error: unknown) {
      toast.error('Failed to delete time entry')
    } finally {
      setDeleting(false)
    }
  }

  // Show loading while checking access
  if (checkingAccess) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (!hasAccess) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
          <p className="text-gray-500">You don&apos;t have permission to view team time entries.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Clock className="w-6 h-6" />
            Time Tracking
          </h1>
          <p className="text-gray-500">View and manage team time entries</p>
        </div>
        <Button onClick={exportToCSV} variant="outline">
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{summary.totalEntries}</div>
              <div className="text-xs text-gray-500">Total Entries</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{summary.totalHours.toFixed(1)}h</div>
              <div className="text-xs text-gray-500">Total Hours</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{summary.uniqueUsers}</div>
              <div className="text-xs text-gray-500">Active Users</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{summary.uniqueProjects}</div>
              <div className="text-xs text-gray-500">Projects</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-yellow-600">{summary.autoClockOuts}</div>
              <div className="text-xs text-gray-500">Auto Clock-Outs</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-1">
              <label className="text-xs text-gray-500">Start Date</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-500">End Date</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-500">User</label>
              <Select value={selectedUser || 'all'} onValueChange={setSelectedUser}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="All Users" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Users</SelectItem>
                  {users.map((user: any) => (
                    <SelectItem key={(user as any).id} value={(user as any).id}>
                      {(user as any).name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleApplyFilters} size="sm">
              Apply
            </Button>
            <Button onClick={handleClearFilters} variant="outline" size="sm">
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Time Entries Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : timeEntries.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-gray-500">
              No time entries found
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead>Clock In</TableHead>
                  <TableHead>Clock Out</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {timeEntries.map((entry: any) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-medium">
                      {formatDate(entry.entry_date)}
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="font-medium">{entry.user?.name || 'Unknown'}</div>
                        <div className="text-xs text-gray-500">{entry.user?.email}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {entry.project?.name || (
                        <span className="text-gray-400 italic">No project</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {entry.task?.name || (
                        <span className="text-gray-400">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {entry.hours_logged.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatTime(entry.clock_in_time)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatTime(entry.clock_out_time)}
                    </TableCell>
                    <TableCell>
                      {entry.is_auto_clock_out ? (
                        <Badge variant="destructive" className="text-xs">
                          Auto
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Normal
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEditEntry(entry)}
                          className="h-8 w-8 p-0"
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeletingEntry(entry)}
                          className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <PaginationBar
            className="px-4 pb-4"
            pagination={pageData?.pagination}
            onPageChange={list.setPage}
            onPageSizeChange={list.setPageSize}
            loading={isValidating && !!pageData}
            itemLabel="entries"
          />
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingEntry} onOpenChange={(open) => !open && setEditingEntry(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Time Entry</DialogTitle>
            <DialogDescription>
              Update hours, project, or description for this time entry
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-hours">Hours Logged</Label>
              <Input
                id="edit-hours"
                type="number"
                step="0.25"
                min="0"
                value={editHours}
                onChange={(e) => setEditHours(e.target.value)}
                placeholder="Enter hours"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-project">Project</Label>
              <Select value={editProject} onValueChange={setEditProject}>
                <SelectTrigger id="edit-project">
                  <SelectValue placeholder="Select project (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Project</SelectItem>
                  {projects.map((project: any) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Input
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Enter description (optional)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingEntry(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={saving || !editHours}>
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deletingEntry} onOpenChange={(open) => !open && setDeletingEntry(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Time Entry</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this time entry? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deletingEntry && (
            <div className="py-4 space-y-2">
              <div className="text-sm">
                <span className="font-medium">Date:</span> {formatDate(deletingEntry.entry_date)}
              </div>
              <div className="text-sm">
                <span className="font-medium">User:</span> {deletingEntry.user?.name}
              </div>
              <div className="text-sm">
                <span className="font-medium">Hours:</span> {deletingEntry.hours_logged.toFixed(2)}
              </div>
              {deletingEntry.project && (
                <div className="text-sm">
                  <span className="font-medium">Project:</span> {deletingEntry.project.name}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingEntry(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteEntry} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete Entry'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
