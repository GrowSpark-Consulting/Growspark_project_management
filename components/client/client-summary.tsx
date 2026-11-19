'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard, type StatDeltaTone } from '@/components/ui/stat-card';
import { StatusBadge } from '@/components/ui/badge';
import { jsonFetcher, formatDay, timeAgo } from '@/lib/client-api';
import { FolderOpen, CheckCircle2, ClipboardCheck, MessageSquareHeart, Flag, FileText, Megaphone } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function ClientSummary() {
  const { data, isLoading } = useSWR('/api/client/portal/summary', jsonFetcher, { refreshInterval: 120000 });
  const s = data?.data;
  if (isLoading || !s) return <Skeleton className="h-32 w-full" />;
  const tiles: { label: string; value: number; icon: typeof FolderOpen; href: string; delta: string; deltaTone: StatDeltaTone }[] = [
    { label: 'Active projects', value: s.totals.active, icon: FolderOpen, href: '/client-portal/projects', delta: `${s.totals.total ?? s.totals.active + s.totals.completed} shared with you`, deltaTone: 'neutral' },
    { label: 'Completed projects', value: s.totals.completed, icon: CheckCircle2, href: '/client-portal/projects', delta: 'Delivered and closed', deltaTone: 'neutral' },
    { label: 'Pending approvals', value: s.pendingApprovals, icon: ClipboardCheck, href: '/client-portal/approvals', delta: s.pendingApprovals ? 'Waiting for your decision' : 'Nothing waiting', deltaTone: s.pendingApprovals ? 'warning' : 'neutral' },
    { label: 'Feedback requests', value: s.feedbackRequests.length, icon: MessageSquareHeart, href: s.feedbackRequests[0] ? `/client-portal/projects/${s.feedbackRequests[0].project_id}` : '/client-portal/projects', delta: s.feedbackRequests.length ? 'Tell us how we did' : 'No open requests', deltaTone: s.feedbackRequests.length ? 'warning' : 'neutral' },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        {tiles.map((t) => (
          <StatCard key={t.label} label={t.label} value={t.value} icon={t.icon} href={t.href} delta={t.delta} deltaTone={t.deltaTone} />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Project progress</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {s.projects.length === 0 && <p className="text-sm text-muted-foreground">No shared projects yet.</p>}
            {s.projects.map((p: any) => (
              <Link key={p.id} href={`/client-portal/projects/${p.id}`} className="block">
                <div className="flex justify-between text-sm"><span className="truncate">{p.name}</span><b>{p.progress_percent}%</b></div>
                <div className="h-1.5 rounded-full bg-sunken"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${p.progress_percent}%` }} /></div>
              </Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1"><Flag className="h-4 w-4" />Upcoming deliveries</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {s.upcomingDeliveries.length === 0 && <p className="text-muted-foreground">Nothing scheduled.</p>}
            {s.upcomingDeliveries.map((d: any) => (
              <Link key={d.id} href={`/client-portal/projects/${d.project_id}`} className="flex gap-2 hover:underline"><span className="text-xs text-muted-foreground w-24">{formatDay(d.date)}</span><span className="truncate">{d.name}</span></Link>
            ))}
            {s.pendingDeliverables.map((d: any) => (
              <Link key={d.id} href="/client-portal/approvals" className="flex items-center gap-2 hover:underline"><span className="w-24 flex-none"><StatusBadge tone="warning">To review</StatusBadge></span><span className="truncate">{d.name}</span></Link>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-1"><Megaphone className="h-4 w-4" />Recent updates</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {s.recentUpdates.length === 0 && <p className="text-muted-foreground">No updates yet.</p>}
            {s.recentUpdates.map((u: any) => (
              <Link key={u.id} href={`/client-portal/projects/${u.project_id}`} className="block hover:underline">
                <span className="text-xs text-muted-foreground">{u.project_name} · {timeAgo(u.created_at)}</span>
                <p className="line-clamp-2">{u.content}</p>
              </Link>
            ))}
            {s.newDocuments.length > 0 && (
              <div className="border-t pt-2">
                <div className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1"><FileText className="h-3 w-3" />New documents</div>
                {s.newDocuments.map((f: any) => (
                  <a key={f.id} href={`/api/client/portal/files/${f.id}`} className="block truncate text-primary">{f.file_name} <span className="text-xs text-muted-foreground">({f.project_name})</span></a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
