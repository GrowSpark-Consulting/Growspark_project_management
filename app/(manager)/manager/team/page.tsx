'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { addDays, format, parseISO, startOfWeek } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useAuth } from '@/lib/hooks/useAuth';
import { profilePermissions, isSuperadminProfile } from '@/lib/portal';
import { jsonFetcher, apiSend, errorMessage, formatDay } from '@/lib/client-api';
import { downloadCsv } from '@/lib/csv';
import { TaskStatusBadge } from '@/components/task/task-status-badge';
import { ChevronLeft, ChevronRight, Download, UserPlus, Mail, Phone } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function ManagerTeamPage() {
  const { userProfile } = useAuth();
  const perms = profilePermissions(userProfile as any);
  const isSuper = isSuperadminProfile(userProfile as any);
  // Role managers invite anyone; project managers invite into their own projects (roles up to their own)
  const canInvite = isSuper || perms.has('manage_user_roles') || perms.has('manage_projects');
  const canDeactivate = isSuper || perms.has('manage_users');
  const [week, setWeek] = useState(() => format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd'));
  const { data, error, isLoading, mutate } = useSWR(`/api/manager/team?weekStart=${week}`, jsonFetcher);
  const [selected, setSelected] = useState<string | null>(null);
  const rows: any[] = data?.data || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Team & Workload</h1>
          <p className="text-gray-600 mt-1">People working on projects you manage</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setWeek((w) => format(addDays(parseISO(w), -7), 'yyyy-MM-dd'))}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm font-medium w-36 text-center">Week of {formatDay(week)}</span>
          <Button variant="outline" size="icon" onClick={() => setWeek((w) => format(addDays(parseISO(w), 7), 'yyyy-MM-dd'))}><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => downloadCsv(rows.map((r) => ({
            name: r.user.name, roles: r.roles.join('; '), open_tasks: r.open_tasks, in_progress: r.in_progress, in_review: r.in_review,
            overdue: r.overdue_tasks, done: r.done_tasks, hours_logged: r.hours_logged_week, available_hours: r.available_hours_week, utilization_percent: r.utilization_percent,
          })), `team-workload-${week}`)}><Download className="h-4 w-4 mr-1" />CSV</Button>
          {canInvite && <Button asChild size="sm"><Link href="/admin/invitations"><UserPlus className="h-4 w-4 mr-1" />Invite employee</Link></Button>}
        </div>
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {error ? <p className="p-4 text-red-600 text-sm">{errorMessage(error)}</p> : isLoading ? <Skeleton className="h-48 m-4" /> : rows.length === 0 ? (
            <p className="p-8 text-center text-gray-500">No team members on your projects yet.</p>
          ) : (
            <table className="w-full text-sm min-w-[820px]">
              <thead><tr className="text-left text-xs text-gray-500 border-b bg-gray-50">
                <th className="p-2">Name</th><th>Roles</th><th className="text-right">Open</th><th className="text-right">In progress</th><th className="text-right">In review</th>
                <th className="text-right">Overdue</th><th className="text-right">Hours / available</th><th className="w-40">Utilization</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const util = r.utilization_percent ?? 0;
                  return (
                    <tr key={r.user.id} className="border-b hover:bg-gray-50">
                      <td className="p-2"><button className="font-medium hover:underline text-left" onClick={() => setSelected(r.user.id)}>{r.user.name}</button>
                        {!r.user.is_active && <Badge variant="outline" className="ml-2 text-xs">Deactivated</Badge>}</td>
                      <td className="text-xs text-gray-600">{r.roles.join(', ')}</td>
                      <td className="text-right">{r.open_tasks}</td><td className="text-right">{r.in_progress}</td><td className="text-right">{r.in_review}</td>
                      <td className={`text-right ${r.overdue_tasks ? 'text-red-600 font-medium' : ''}`}>{r.overdue_tasks}</td>
                      <td className="text-right">{r.hours_logged_week} / {r.available_hours_week}</td>
                      <td><div className="flex items-center gap-2"><div className="h-2 flex-1 rounded bg-gray-200"><div className={`h-2 rounded ${util > 100 ? 'bg-red-500' : util > 85 ? 'bg-amber-500' : 'bg-green-500'}`} style={{ width: `${Math.min(100, util)}%` }} /></div><span className="text-xs w-10">{util}%</span></div></td>
                      <td className="pr-2"><Button size="sm" variant="ghost" onClick={() => setSelected(r.user.id)}>Details</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <EmployeeDialog userId={selected} onClose={() => setSelected(null)} canDeactivate={canDeactivate} onChanged={() => mutate()} />
    </div>
  );
}

function EmployeeDialog({ userId, onClose, canDeactivate, onChanged }: { userId: string | null; onClose: () => void; canDeactivate: boolean; onChanged: () => void }) {
  const { data, mutate } = useSWR(userId ? `/api/users/${userId}` : null, jsonFetcher);
  const d = data?.data;
  const toggle = async () => {
    if (!d) return;
    const next = !d.profile.is_active;
    if (!confirm(next ? 'Reactivate this account?' : 'Deactivate this account? The person will not be able to sign in.')) return;
    try {
      await apiSend(`/api/users/${userId}/status`, 'POST', { active: next });
      toast.success(next ? 'Account reactivated' : 'Account deactivated');
      mutate(); onChanged();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <Dialog open={!!userId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {!d ? <><DialogHeader><DialogTitle>Loading…</DialogTitle><DialogDescription /></DialogHeader><Skeleton className="h-40" /></> : (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>{d.profile.name}</DialogTitle>
              <DialogDescription className="flex flex-wrap gap-3">
                <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{d.profile.email}</span>
                {d.profile.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{d.profile.phone}</span>}
                <span>{d.profile.is_active ? 'Active' : 'Deactivated'}</span>
                {d.profile.last_sign_in_at && <span>Last sign-in {formatDay(d.profile.last_sign_in_at)}</span>}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-1">{d.roles.map((r: any) => <Badge key={r.id} variant="outline">{r.name}{r.department ? ` · ${r.department}` : ''}</Badge>)}</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
              {[['Open', d.stats.open], ['Overdue', d.stats.overdue], ['Done', d.stats.done], ['Hours this week', d.stats.hoursThisWeek], ['Available', d.stats.availableThisWeek]].map(([l, v]) => (
                <Card key={l as string}><CardContent className="p-2"><div className="text-lg font-bold">{v as any}</div><div className="text-[11px] text-gray-500">{l as string}</div></CardContent></Card>
              ))}
            </div>
            <Card>
              <CardHeader className="py-2"><CardTitle className="text-sm">Projects</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">{d.projects.map((p: any) => <Link key={p.id} href={`/projects/${p.id}`} className="text-sm text-blue-600 hover:underline">{p.name}{p.role_in_project ? ` (${p.role_in_project})` : ''}</Link>)}</CardContent>
            </Card>
            <Card>
              <CardHeader className="py-2"><CardTitle className="text-sm">Open tasks</CardTitle><CardDescription>{d.openTasks.length} shown</CardDescription></CardHeader>
              <CardContent className="space-y-1">
                {d.openTasks.map((t: any) => (
                  <Link key={t.id} href={`/projects/${t.project_id}?task=${t.id}`} className="flex items-center gap-2 text-sm hover:underline">
                    <TaskStatusBadge status={t.status} /><span className="flex-1 truncate">{t.name}</span><span className="text-xs text-gray-500">{formatDay(t.due_date)}</span>
                  </Link>
                ))}
              </CardContent>
            </Card>
            {canDeactivate && (
              <div className="flex justify-end">
                <Button variant={d.profile.is_active ? 'destructive' : 'default'} size="sm" onClick={toggle}>{d.profile.is_active ? 'Deactivate account' : 'Reactivate account'}</Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
