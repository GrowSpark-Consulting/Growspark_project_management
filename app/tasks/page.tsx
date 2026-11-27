'use client';

import { useEffect, useState } from 'react';
import { AssigneeAvatars } from '@/components/task/assignee-avatars'
import { useListParams } from '@/lib/hooks/use-list-params';
import { PaginationBar } from '@/components/ui/pagination-bar';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TaskStatusBadge, PriorityBadge } from '@/components/task/task-status-badge';
import TaskDetailDialog from '@/components/task/task-detail-dialog';
import { jsonFetcher, apiSend, errorMessage, formatDay } from '@/lib/client-api';
import { TASK_STATUSES, statusLabel, availableActions, TASK_ACTIONS, type TaskAction } from '@/lib/task-rules';
import { ListChecks, AlertTriangle, Play, Pause, Send } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
const VIEWS = [
  { key: 'assigned', label: 'Assigned to me' },
  { key: 'created', label: 'Created by me' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'review', label: 'Awaiting review' },
  { key: 'changes_requested', label: 'Changes requested' },
  { key: 'done', label: 'Completed' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'to_review', label: 'To review (as reviewer)' },
];

export default function MyTasksPage() {
  // View, filters, search and page live in the URL; the server filters, sorts and pages
  const list = useListParams('my-tasks', { view: 'assigned', projectId: '', priority: '', status: '', due: '', q: '' });
  const { view, projectId: projectFilter, priority: priorityFilter, status: statusFilter, due: dueFilter } = list.values;
  const projectId = projectFilter || 'all';
  const priority = priorityFilter || 'all';
  const status = statusFilter || 'all';
  const due = dueFilter || 'all';
  const pick = (key: 'view' | 'projectId' | 'priority' | 'status' | 'due') => (value: string) => list.update({ [key]: value === 'all' ? '' : value });
  const setView = pick('view');
  const setProjectId = pick('projectId');
  const setPriority = pick('priority');
  const setStatus = pick('status');
  const setDue = pick('due');
  const [q, setQ] = useState(list.values.q);
  useEffect(() => { setQ(list.values.q); }, [list.values.q]);
  useEffect(() => {
    if (q.trim() === list.values.q) return;
    const timer = setTimeout(() => list.update({ q: q.trim() }), 350);
    return () => clearTimeout(timer);
  }, [q, list]);
  const [openId, setOpenId] = useState<string | null>(null);

  const query = `/api/me/tasks?${list.apiQuery}`;
  const { data, error, isLoading, isValidating, mutate } = useSWR(query, jsonFetcher, { keepPreviousData: true });
  const tasks: any[] = data?.data || [];
  const counts = data?.meta?.counts || {};
  const projects: any[] = data?.meta?.projects || [];
  const today = new Date().toISOString().slice(0, 10);

  const quick = async (task: any, action: TaskAction) => {
    try {
      await apiSend(`/api/tasks/${task.id}/status`, 'POST', { action, timer: action !== 'submit' });
      toast.success(TASK_ACTIONS[action].label);
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><ListChecks className="h-7 w-7" />My Tasks</h1>
        <p className="text-gray-600 mt-1">Everything assigned to you, created by you, or waiting for your review</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <Button key={v.key} size="sm" variant={view === v.key ? 'default' : 'outline'} onClick={() => setView(v.key)}>
            {v.label}<span className="ml-1.5 rounded-full bg-black/10 px-1.5 text-[11px]">{counts[v.key] ?? 0}</span>
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Input placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} className="col-span-2 md:col-span-1" />
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger><SelectValue placeholder="Project" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All projects</SelectItem>{projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent><SelectItem value="all">Any priority</SelectItem>{['urgent', 'high', 'medium', 'low'].map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent><SelectItem value="all">Any status</SelectItem>{TASK_STATUSES.map((s) => <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={due} onValueChange={setDue}>
          <SelectTrigger><SelectValue placeholder="Deadline" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any deadline</SelectItem><SelectItem value="today">Due today</SelectItem>
            <SelectItem value="week">Due in 7 days</SelectItem><SelectItem value="overdue">Overdue</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {error ? (
            <p className="p-6 text-sm text-red-600">{errorMessage(error)}</p>
          ) : isLoading && !data ? (
            <div className="p-4 space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : tasks.length === 0 ? (
            <div className="p-10 text-center text-gray-500">
              <ListChecks className="h-10 w-10 mx-auto mb-2 opacity-40" />No tasks here.
            </div>
          ) : (
            <ul className="divide-y">
              {tasks.map((t) => {
                const overdue = t.due_date && t.due_date.slice(0, 10) < today && t.status !== 'done';
                // A task shared by several people: the buttons act on my own part (done = my part complete)
                const shared = (t.assignees?.length || 0) > 1 && !!t.my_part
                const PART_AS_STATUS: Record<string, string> = { todo: 'todo', in_progress: 'in_progress', blocked: 'on_hold', done: 'review' }
                const actionStatus = shared && t.status !== 'done' ? PART_AS_STATUS[t.my_part.status] || 'todo' : t.status
                const actions = availableActions(actionStatus, { canContribute: true, canReview: false }).filter((a) => ['start', 'resume', 'pause', 'submit'].includes(a));
                return (
                  <li key={t.id} className="flex flex-col md:flex-row md:items-center gap-2 p-3 hover:bg-gray-50">
                    <button className="flex-1 text-left min-w-0" onClick={() => setOpenId(t.id)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium truncate">{t.name}</span>
                        <TaskStatusBadge status={t.status} />
                        <PriorityBadge priority={t.priority} />
                        {t.parent_task_id && <span className="text-[11px] text-gray-400">subtask</span>}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 mt-0.5">
                        <Link href={`/projects/${t.project_id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{t.project?.name}</Link>
                        {t.due_date && <span className={overdue ? 'text-red-600 font-medium flex items-center gap-1' : ''}>{overdue && <AlertTriangle className="h-3 w-3" />}Due {formatDay(t.due_date)}</span>}
                        {t.subtasks?.total > 0 && <span>{t.subtasks.done}/{t.subtasks.total} subtasks</span>}
                        {shared ? (
                          <span data-testid="shared-task-progress">Shared · my part {t.my_part.progress_percent}% · {t.assignee_summary?.done}/{t.assignee_summary?.total} done · {t.progress_percent}% overall</span>
                        ) : t.progress_percent > 0 && t.status !== 'done' && <span>{t.progress_percent}%</span>}
                        {(t.assignees?.length || 0) > 1 && <AssigneeAvatars assignees={t.assignees} />}
                        {t.status === 'changes_requested' && t.review_note && <span className="text-red-600 truncate max-w-xs">“{t.review_note}”</span>}
                      </div>
                    </button>
                    {view !== 'to_review' && t.assigned_to && (
                      <div className="flex gap-1">
                        {actions.map((a) => {
                          const Icon = a === 'pause' ? Pause : a === 'submit' ? Send : Play;
                          return <Button key={a} size="sm" variant="outline" onClick={() => quick(t, a)}><Icon className="h-3.5 w-3.5 mr-1" />{shared && a === 'submit' ? 'Complete my part' : TASK_ACTIONS[a].label}</Button>;
                        })}
                      </div>
                    )}
                    {view === 'to_review' && <Button size="sm" onClick={() => setOpenId(t.id)}>Review</Button>}
                  </li>
                );
              })}
            </ul>
          )}
          <PaginationBar
            className="px-3 pb-3"
            pagination={data?.meta?.pagination}
            onPageChange={list.setPage}
            onPageSizeChange={list.setPageSize}
            loading={isValidating && !!data}
            itemLabel="tasks"
          />
        </CardContent>
      </Card>

      <TaskDetailDialog taskId={openId} open={!!openId} onOpenChange={(o) => !o && setOpenId(null)} onChanged={() => mutate()} />
    </div>
  );
}
