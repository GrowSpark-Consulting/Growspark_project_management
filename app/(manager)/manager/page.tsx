'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard, type StatDeltaTone } from '@/components/ui/stat-card';
import { jsonFetcher, errorMessage, formatDay, timeAgo } from '@/lib/client-api';
import { downloadCsv } from '@/lib/csv';
import { statusLabel } from '@/lib/task-rules';
import { BriefcaseBusiness, Download, AlertTriangle, Users, ListChecks, Inbox, Star, Wallet } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ACTION_TEXT: Record<string, string> = {
  created: 'created', status_changed: 'moved', assigned: 'reassigned', priority_changed: 'changed priority of',
  progress_updated: 'updated progress on', review_submitted: 'submitted for review', review_approved: 'approved',
  changes_requested: 'requested changes on', reopened: 'reopened',
};

export default function ManagerOverviewPage() {
  const { data, error, isLoading } = useSWR('/api/manager/overview', jsonFetcher, { refreshInterval: 120000 });
  const o = data?.data;
  if (error) return <p className="text-red-600">{errorMessage(error)}</p>;
  if (isLoading || !o) return <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>;

  const approvals = o.pendingApprovals.tasks + o.pendingApprovals.timesheets + o.pendingApprovals.deliverables;
  const projectIssues = [o.counts.delayed ? `${o.counts.delayed} delayed` : '', o.counts.overBudget ? `${o.counts.overBudget} over budget` : ''].filter(Boolean).join(' · ');
  // Four KPIs (design system: 3–4 per row, never more than 6 on a screen)
  const kpis = [
    {
      label: 'Active projects', value: o.counts.active, icon: BriefcaseBusiness, href: '/projects',
      delta: projectIssues || `${o.counts.completed} completed of ${o.counts.total}`,
      deltaTone: (projectIssues ? 'danger' : 'neutral') as StatDeltaTone,
    },
    {
      label: 'Open tasks', value: o.tasks.pending, icon: ListChecks,
      delta: o.tasks.overdue ? `${o.tasks.overdue} overdue` : `${o.tasks.completed} completed`,
      deltaTone: (o.tasks.overdue ? 'danger' : 'neutral') as StatDeltaTone,
    },
    {
      label: 'Pending approvals', value: approvals, icon: Inbox, href: '/manager/approvals',
      delta: `${o.pendingApprovals.tasks} tasks · ${o.pendingApprovals.timesheets} timesheets · ${o.pendingApprovals.deliverables} deliverables`,
      deltaTone: 'neutral' as StatDeltaTone,
    },
    {
      label: 'Team', value: o.employees, icon: Users, href: '/manager/team',
      delta: o.risks.open ? `${o.risks.open} open risks${o.risks.high ? ` (${o.risks.high} high)` : ''}` : 'No open risks',
      deltaTone: (o.risks.high ? 'warning' : 'neutral') as StatDeltaTone,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Manager Overview</h1>
          <p className="text-gray-600 mt-1">{o.scope.all ? 'All projects in the organization' : `Projects you manage (${o.scope.projects})`}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline"><Link href="/projects">All projects</Link></Button>
          <Button asChild><Link href="/manager/approvals"><Inbox className="h-4 w-4 mr-1" />Approvals{approvals ? ` (${approvals})` : ''}</Link></Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        {kpis.map((k) => (
          <StatCard key={k.label} label={k.label} value={k.value} icon={k.icon} href={k.href} delta={k.delta} deltaTone={k.deltaTone} />
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div><CardTitle className="text-lg">Projects</CardTitle><CardDescription>Progress = completed top-level tasks</CardDescription></div>
          <Button size="sm" variant="outline" onClick={() => downloadCsv(o.projects.map((p: any) => ({
            project: p.name, account: p.account, status: p.status, priority: p.priority, progress_percent: p.progress_percent,
            tasks_done: p.tasks_done, tasks_total: p.tasks_total, overdue_tasks: p.overdue_tasks, estimated_hours: p.estimated_hours,
            logged_hours: p.logged_hours, budget_percent: p.budget_percent, end_date: p.end_date, delayed: p.is_delayed ? 'yes' : 'no',
          })), 'projects-overview')}><Download className="h-4 w-4 mr-1" />CSV</Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {o.projects.length === 0 ? <p className="text-sm text-gray-500">No projects in your scope yet.</p> : (
            <table className="w-full text-sm min-w-[760px]">
              <thead><tr className="text-left text-xs text-gray-500 border-b">
                <th className="py-2">Project</th><th>Status</th><th className="w-40">Progress</th><th className="text-right">Overdue</th>
                <th className="text-right">Hours (est / logged)</th><th className="text-center">Budget</th><th>Next milestone</th><th>Deadline</th>
              </tr></thead>
              <tbody>
                {o.projects.map((p: any) => (
                  <tr key={p.id} className="border-b hover:bg-gray-50">
                    <td className="py-2"><Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link><div className="text-xs text-gray-500">{p.account}</div></td>
                    <td><Badge variant="outline" className="capitalize">{p.status?.replace('_', ' ')}</Badge></td>
                    <td><div className="flex items-center gap-2"><div className="h-2 flex-1 rounded bg-gray-200"><div className="h-2 rounded bg-blue-600" style={{ width: `${p.progress_percent}%` }} /></div><span className="text-xs w-9">{p.progress_percent}%</span></div></td>
                    <td className={`text-right ${p.overdue_tasks ? 'text-red-600 font-medium' : ''}`}>{p.overdue_tasks}</td>
                    <td className="text-right">{p.estimated_hours ?? '—'} / {p.logged_hours}</td>
                    <td className="text-center">{p.budget_percent == null ? <span className="text-gray-300">—</span> : (
                      <Badge className={`border-0 ${p.budget_status === 'over' ? 'bg-red-100 text-red-800' : p.budget_status === 'warning' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}><Wallet className="h-3 w-3 mr-1" />{p.budget_percent}%</Badge>
                    )}</td>
                    <td className="text-xs">{p.next_milestone ? `${p.next_milestone.name} · ${formatDay(p.next_milestone.date)}` : '—'}</td>
                    <td className={`text-xs ${p.is_delayed ? 'text-red-600 font-medium' : ''}`}>{p.is_delayed && <AlertTriangle className="inline h-3 w-3 mr-1" />}{formatDay(p.end_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-lg">Team workload</CardTitle><CardDescription>Open tasks per person</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {o.workload.length === 0 && <p className="text-sm text-gray-500">No team members yet.</p>}
            {o.workload.slice(0, 10).map((w: any) => (
              <div key={w.user.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 truncate">{w.user.name}</span>
                <div className="w-24 h-2 rounded bg-gray-200"><div className="h-2 rounded bg-indigo-500" style={{ width: `${Math.min(100, w.open * 10)}%` }} /></div>
                <span className="w-16 text-right text-xs">{w.open} open{w.overdue ? <span className="text-red-600"> · {w.overdue}!</span> : ''}</span>
              </div>
            ))}
            <Link href="/manager/team" className="text-xs text-blue-600">View team →</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-lg">Pending approvals</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Link href="/manager/approvals" className="flex justify-between hover:underline"><span>Tasks to review</span><b>{o.pendingApprovals.tasks}</b></Link>
            <Link href="/manager/timesheets" className="flex justify-between hover:underline"><span>Timesheets</span><b>{o.pendingApprovals.timesheets}</b></Link>
            <Link href="/manager/approvals" className="flex justify-between hover:underline"><span>Deliverables (internal review)</span><b>{o.pendingApprovals.deliverables}</b></Link>
            <div className="border-t pt-2">
              <div className="text-xs font-semibold text-gray-500 mb-1 flex items-center gap-1"><Star className="h-3 w-3" />Client feedback {o.clientFeedback.average != null && `· avg ${o.clientFeedback.average}/10`}</div>
              {o.clientFeedback.recent.length === 0 ? <p className="text-xs text-gray-400">No feedback yet</p> : o.clientFeedback.recent.map((f: any) => (
                <div key={f.id} className="text-xs"><b>{f.project_name}</b>{f.satisfaction_score ? ` · ${f.satisfaction_score}/10` : ''} — {f.what_needs_improvement || f.what_went_well || ''}</div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-lg">Upcoming deadlines</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {o.upcomingDeadlines.length === 0 && <p className="text-sm text-gray-500">Nothing upcoming.</p>}
            {o.upcomingDeadlines.map((d: any) => (
              <Link key={`${d.type}${d.id}`} href={d.type === 'task' ? `/projects/${d.project_id}?task=${d.id}` : `/projects/${d.project_id}`} className="flex gap-2 hover:underline">
                <span className="text-xs text-gray-500 w-20 flex-shrink-0">{formatDay(d.date)}</span>
                <span className="truncate">{d.type === 'milestone' ? '🏁 ' : ''}{d.name}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-lg">Recent project activity</CardTitle></CardHeader>
        <CardContent>
          {o.recentActivity.length === 0 ? <p className="text-sm text-gray-500">No activity yet.</p> : (
            <ul className="space-y-1 text-sm">
              {o.recentActivity.map((a: any) => (
                <li key={a.id} className="flex flex-wrap gap-1">
                  <b>{a.actor_name}</b> {ACTION_TEXT[a.action] || a.action}
                  <Link href={`/projects/${a.project_id}?task=${a.task_id}`} className="text-blue-600 hover:underline">{a.task_name}</Link>
                  {a.action === 'status_changed' && <span className="text-gray-500">→ {statusLabel(a.to_value)}</span>}
                  <span className="text-gray-500">· {a.project_name} · {timeAgo(a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
