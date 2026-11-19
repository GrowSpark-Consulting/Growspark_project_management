'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard, type StatDeltaTone } from '@/components/ui/stat-card';
import { jsonFetcher, formatDay } from '@/lib/client-api';
import { Clock, FolderOpen, ListChecks, Send, Flag } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function MyWorkSummary() {
  const { data, isLoading } = useSWR('/api/me/summary', jsonFetcher, { refreshInterval: 120000 });
  const s = data?.data;
  if (isLoading || !s) return <Skeleton className="h-28 w-full" />;
  // Four KPIs (design system: 3–4 per row, never more than 6 on a screen); details go in the context line
  const tiles: { label: string; value: React.ReactNode; icon: typeof ListChecks; href: string; delta: string; deltaTone: StatDeltaTone }[] = [
    {
      label: 'My open tasks', value: s.pending, icon: ListChecks, href: '/tasks?view=assigned',
      delta: s.overdue.length ? `${s.overdue.length} overdue` : s.dueToday.length ? `${s.dueToday.length} due today` : `${s.assigned} assigned to me`,
      deltaTone: s.overdue.length ? 'danger' : s.dueToday.length ? 'warning' : 'neutral',
    },
    {
      label: 'In review', value: s.awaitingReview, icon: Send, href: '/tasks',
      delta: s.changesRequested ? `${s.changesRequested} with changes requested` : 'No changes requested',
      deltaTone: s.changesRequested ? 'danger' : 'neutral',
    },
    {
      label: 'Hours this week', value: s.hoursThisWeek, icon: Clock, href: '/timesheets',
      delta: `${s.completedThisWeek} tasks completed this week`, deltaTone: 'neutral',
    },
    {
      label: 'Active projects', value: s.activeProjects, icon: FolderOpen, href: '/projects',
      delta: s.unreadNotifications ? `${s.unreadNotifications} unread notifications` : 'All caught up',
      deltaTone: 'neutral',
    },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        {tiles.map((t) => (
          <StatCard key={t.label} label={t.label} value={t.value} icon={t.icon} href={t.href} delta={t.delta} deltaTone={t.deltaTone} />
        ))}
      </div>
      {(s.dueToday.length > 0 || s.overdue.length > 0 || s.nextMilestones.length > 0 || s.lastWeekTimesheet?.status === 'rejected') && (
        <Card className="py-5">
          <CardContent className="px-5 grid grid-cols-1 md:grid-cols-3 gap-5 text-sm">
            <div>
              <div className="text-[13px] font-medium text-ink-muted mb-2">Today&apos;s deadlines</div>
              {s.dueToday.length === 0 ? <p className="text-[13px] text-ink-muted">Nothing due today</p> : s.dueToday.slice(0, 5).map((t: any) => (
                <Link key={t.id} href={`/projects/${t.project_id}?task=${t.id}`} className="block truncate py-0.5 text-ink hover:text-primary hover:underline">{t.name}</Link>
              ))}
            </div>
            <div>
              <div className="text-[13px] font-medium text-danger mb-2">Overdue</div>
              {s.overdue.length === 0 ? <p className="text-[13px] text-ink-muted">No overdue tasks</p> : s.overdue.slice(0, 5).map((t: any) => (
                <Link key={t.id} href={`/projects/${t.project_id}?task=${t.id}`} className="block truncate py-0.5 text-ink hover:text-primary hover:underline">{t.name} <span className="text-[13px] text-ink-muted">({formatDay(t.due_date)})</span></Link>
              ))}
            </div>
            <div>
              <div className="text-[13px] font-medium text-ink-muted mb-2 flex items-center gap-1"><Flag className="h-4 w-4" strokeWidth={1.75} />Next milestones</div>
              {s.nextMilestones.length === 0 ? <p className="text-[13px] text-ink-muted">No upcoming milestones</p> : s.nextMilestones.map((m: any) => (
                <Link key={m.id} href={`/projects/${m.project_id}`} className="block truncate py-0.5 text-ink hover:text-primary hover:underline">{m.name} <span className="text-[13px] text-ink-muted">({formatDay(m.date)})</span></Link>
              ))}
              {s.lastWeekTimesheet?.status === 'rejected' && (
                <Link href="/timesheets" className="block mt-2 text-[13px] font-medium text-danger">Last week&apos;s timesheet was rejected. Review it.</Link>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
