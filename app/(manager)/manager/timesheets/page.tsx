'use client';

import { Fragment, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { addDays, format, parseISO, startOfWeek } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { jsonFetcher, apiSend, errorMessage, formatDay } from '@/lib/client-api';
import { downloadCsv } from '@/lib/csv';
import { ChevronLeft, ChevronRight, Download, Check, X } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS_CLS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-800', submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800', rejected: 'bg-red-100 text-red-800',
};

export default function ManagerTimesheetsPage() {
  const [week, setWeek] = useState(() => format(startOfWeek(addDays(new Date(), -7), { weekStartsOn: 1 }), 'yyyy-MM-dd'));
  const [status, setStatus] = useState('all');
  const { data, error, isLoading, mutate } = useSWR(`/api/manager/timesheets?weekStart=${week}&status=${status}`, jsonFetcher);
  const rows: any[] = data?.data || [];
  const [expanded, setExpanded] = useState<string | null>(null);

  const review = async (row: any, decision: 'approve' | 'reject') => {
    const note = decision === 'reject' ? prompt('Reason for rejecting (required)') : null;
    if (decision === 'reject' && !note) return;
    try {
      await apiSend(`/api/timesheets/${row.timesheet.id}/review`, 'POST', { decision, note });
      toast.success(decision === 'approve' ? 'Timesheet approved' : 'Timesheet rejected');
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const dayKeys = rows[0] ? Object.keys(rows[0].days) : Array.from({ length: 7 }, (_, i) => format(addDays(parseISO(week), i), 'yyyy-MM-dd'));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Timesheets</h1>
          <p className="text-gray-600 mt-1">Review and approve weekly hours of your team (hours on projects you manage)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => setWeek((w) => format(addDays(parseISO(w), -7), 'yyyy-MM-dd'))}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm font-medium w-36 text-center">Week of {formatDay(week)}</span>
          <Button variant="outline" size="icon" aria-label="Next week" onClick={() => setWeek((w) => format(addDays(parseISO(w), 7), 'yyyy-MM-dd'))}><ChevronRight className="h-4 w-4" /></Button>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem><SelectItem value="submitted">Submitted</SelectItem><SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem><SelectItem value="draft">Not submitted</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => downloadCsv(rows.flatMap((r) => r.entries.map((e: any) => ({
            employee: r.user.name, status: r.status, date: e.date, project: e.project_name, task: e.task_name, hours: e.hours, description: e.description,
          }))), `timesheets-${week}`)}><Download className="h-4 w-4 mr-1" />CSV</Button>
        </div>
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {error ? <p className="p-4 text-sm text-red-600">{errorMessage(error)}</p> : isLoading ? <Skeleton className="h-40 m-4" /> : rows.length === 0 ? (
            <p className="p-8 text-center text-gray-500">No timesheets for this week.</p>
          ) : (
            <table className="w-full text-sm min-w-[860px]">
              <thead><tr className="text-left text-xs text-gray-500 border-b bg-gray-50">
                <th className="p-2">Employee</th>{dayKeys.map((d) => <th key={d} className="text-right">{format(parseISO(d), 'EEE d')}</th>)}
                <th className="text-right">Total</th><th className="text-center">Status</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.user.id}>
                    <tr className="border-b hover:bg-gray-50">
                      <td className="p-2"><button className="font-medium hover:underline" onClick={() => setExpanded(expanded === r.user.id ? null : r.user.id)}>{r.user.name}</button></td>
                      {dayKeys.map((d) => <td key={d} className="text-right">{r.days[d] || <span className="text-gray-300">–</span>}</td>)}
                      <td className="text-right font-semibold">{r.total}</td>
                      <td className="text-center"><Badge className={`border-0 capitalize ${STATUS_CLS[r.status]}`}>{r.status === 'draft' ? 'not submitted' : r.status}</Badge></td>
                      <td className="pr-2 text-right whitespace-nowrap">
                        {r.can_review && (
                          <>
                            <Button size="sm" className="mr-1" onClick={() => review(r, 'approve')}><Check className="h-3.5 w-3.5 mr-1" />Approve</Button>
                            <Button size="sm" variant="outline" onClick={() => review(r, 'reject')}><X className="h-3.5 w-3.5 mr-1" />Reject</Button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expanded === r.user.id && (
                      <tr className="bg-gray-50/60">
                        <td colSpan={dayKeys.length + 4} className="p-3">
                          {r.entries.length === 0 ? <p className="text-xs text-gray-500">No entries.</p> : (
                            <ul className="space-y-1 text-xs">
                              {r.entries.map((e: any) => (
                                <li key={e.id} className="flex gap-3"><span className="w-20">{formatDay(e.date)}</span><span className="w-12 text-right font-medium">{e.hours}h</span><span className="font-medium">{e.project_name}</span>{e.task_name && <span>· {e.task_name}</span>}{e.description && <span className="text-gray-500">— {e.description}</span>}</li>
                              ))}
                            </ul>
                          )}
                          {r.timesheet?.review_note && <p className="text-xs mt-2 italic">Review note: {r.timesheet.review_note}</p>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
