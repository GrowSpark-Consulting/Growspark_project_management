'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import TaskDetailDialog from '@/components/task/task-detail-dialog';
import { jsonFetcher, apiSend, errorMessage, formatDay, timeAgo } from '@/lib/client-api';
import { Check, MessageSquareWarning, Share2, Undo2, ExternalLink, Download } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function ManagerApprovalsPage() {
  const { data, error, isLoading, mutate } = useSWR('/api/manager/approvals', jsonFetcher);
  const a = data?.data;
  const [openTask, setOpenTask] = useState<string | null>(null);

  const taskAction = async (id: string, action: 'approve' | 'request_changes') => {
    const note = action === 'request_changes' ? prompt('What needs to change? (required)') : prompt('Approval note (optional)') || undefined;
    if (action === 'request_changes' && !note) return;
    try {
      await apiSend(`/api/tasks/${id}/status`, 'POST', { action, note });
      toast.success(action === 'approve' ? 'Task approved' : 'Changes requested');
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const deliverableAction = async (id: string, action: 'share' | 'return') => {
    const note = action === 'return' ? prompt('Note for the team (optional)') || null : null;
    try {
      await apiSend(`/api/deliverables/${id}/action`, 'POST', { action, note });
      toast.success(action === 'share' ? 'Shared with client' : 'Returned to team');
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const timesheetAction = async (id: string, decision: 'approve' | 'reject') => {
    const note = decision === 'reject' ? prompt('Reason (required)') : null;
    if (decision === 'reject' && !note) return;
    try { await apiSend(`/api/timesheets/${id}/review`, 'POST', { decision, note }); toast.success('Saved'); mutate(); } catch (e) { toast.error(errorMessage(e)); }
  };

  if (error) return <p className="text-red-600">{errorMessage(error)}</p>;
  if (isLoading || !a) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Approvals</h1>
        <p className="text-gray-600 mt-1">Everything waiting for your decision</p>
      </div>
      <Tabs defaultValue="tasks">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="tasks">Tasks to review ({a.tasks.length})</TabsTrigger>
          <TabsTrigger value="deliverables">Deliverables ({a.deliverables.length})</TabsTrigger>
          <TabsTrigger value="timesheets">Timesheets ({a.timesheets.length})</TabsTrigger>
          <TabsTrigger value="workflow">Workflow steps ({a.workflowSteps?.length || 0})</TabsTrigger>
          <TabsTrigger value="client">Client decisions ({a.clientDecisions.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="tasks">
          <List empty="No tasks waiting for review.">
            {a.tasks.map((t: any) => (
              <Row key={t.id}>
                <div className="flex-1 min-w-0">
                  <button className="font-medium hover:underline text-left" onClick={() => setOpenTask(t.id)}>{t.name}</button>
                  <div className="text-xs text-gray-500">{t.project_name} · by {t.assignee_name} · submitted {timeAgo(t.updated_at)}{t.review_note ? ` · “${t.review_note}”` : ''}</div>
                </div>
                <Button size="sm" onClick={() => taskAction(t.id, 'approve')}><Check className="h-3.5 w-3.5 mr-1" />Approve</Button>
                <Button size="sm" variant="outline" onClick={() => taskAction(t.id, 'request_changes')}><MessageSquareWarning className="h-3.5 w-3.5 mr-1" />Request changes</Button>
              </Row>
            ))}
          </List>
        </TabsContent>

        <TabsContent value="deliverables">
          <List empty="No deliverables waiting for internal review.">
            {a.deliverables.map((d: any) => (
              <Row key={d.id}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{d.name} <span className="text-xs text-gray-400">v{d.version || 1}</span></div>
                  <div className="text-xs text-gray-500 flex flex-wrap gap-2">
                    <Link href={`/projects/${d.project_id}`} className="hover:underline">{d.project_name}</Link>
                    <span>by {d.submitted_by_name}</span><span>{timeAgo(d.submitted_at)}</span>
                    {d.file_id && <a href={`/api/files/${d.file_id}`} className="text-blue-600 flex items-center gap-1"><Download className="h-3 w-3" />File</a>}
                    {d.file_url && <a href={d.file_url} target="_blank" rel="noreferrer" className="text-blue-600 flex items-center gap-1"><ExternalLink className="h-3 w-3" />Link</a>}
                  </div>
                </div>
                <Button size="sm" onClick={() => deliverableAction(d.id, 'share')}><Share2 className="h-3.5 w-3.5 mr-1" />Approve & share with client</Button>
                <Button size="sm" variant="outline" onClick={() => deliverableAction(d.id, 'return')}><Undo2 className="h-3.5 w-3.5 mr-1" />Return</Button>
              </Row>
            ))}
          </List>
        </TabsContent>

        <TabsContent value="timesheets">
          <List empty="No submitted timesheets.">
            {a.timesheets.map((s: any) => (
              <Row key={s.id}>
                <div className="flex-1"><div className="font-medium">{s.user_name}</div><div className="text-xs text-gray-500">Week of {formatDay(s.week_start_date)} · {s.total_hours}h · submitted {timeAgo(s.submitted_at)}</div></div>
                <Button size="sm" variant="outline" asChild><Link href="/manager/timesheets">View</Link></Button>
                <Button size="sm" onClick={() => timesheetAction(s.id, 'approve')}><Check className="h-3.5 w-3.5 mr-1" />Approve</Button>
                <Button size="sm" variant="outline" onClick={() => timesheetAction(s.id, 'reject')}>Reject</Button>
              </Row>
            ))}
          </List>
        </TabsContent>

        <TabsContent value="workflow">
          <List empty="No workflow steps waiting on you.">
            {(a.workflowSteps || []).map((w: any, i: number) => {
              const projectId = w.project_id || w.projects?.id || w.workflow_instances?.project_id;
              const name = w.project_name || w.projects?.name || w.project?.name || 'Project';
              return (
                <Row key={w.id || i}>
                  <div className="flex-1"><div className="font-medium">{name}</div><div className="text-xs text-gray-500">{w.node_label || w.workflow_nodes?.label || w.label || 'Approval step'}</div></div>
                  {projectId && <Button size="sm" asChild><Link href={`/projects/${projectId}`}>Open</Link></Button>}
                </Row>
              );
            })}
          </List>
        </TabsContent>

        <TabsContent value="client">
          <List empty="No client decisions in the last 14 days.">
            {a.clientDecisions.map((d: any) => (
              <Row key={d.id}>
                <Badge className={`border-0 ${d.status === 'approved' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{d.status}</Badge>
                <div className="flex-1"><div className="font-medium">{d.name}</div><div className="text-xs text-gray-500">{d.project_name} · {d.client_name} · {timeAgo(d.approved_at)}{d.feedback ? ` · “${d.feedback}”` : ''}</div></div>
                <Button size="sm" variant="outline" asChild><Link href={`/projects/${d.project_id}`}>Open project</Link></Button>
              </Row>
            ))}
          </List>
        </TabsContent>
      </Tabs>
      <TaskDetailDialog taskId={openTask} open={!!openTask} onOpenChange={(o) => !o && setOpenTask(null)} onChanged={() => mutate()} />
    </div>
  );
}

function List({ children, empty }: { children: React.ReactNode; empty: string }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <Card><CardContent className="p-0">
      {items.filter(Boolean).length === 0 ? <p className="p-8 text-center text-gray-500">{empty}</p> : <ul className="divide-y">{children}</ul>}
    </CardContent></Card>
  );
}
function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex flex-wrap items-center gap-2 p-3">{children}</li>;
}
