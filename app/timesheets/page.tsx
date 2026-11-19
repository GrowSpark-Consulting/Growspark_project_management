'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { addDays, format, parseISO, startOfWeek } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { jsonFetcher, apiSend, errorMessage, formatDay } from '@/lib/client-api';
import { ClipboardCheck, ChevronLeft, ChevronRight, Send, Lock } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS_CLS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-800',
  submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
};

export default function TimesheetsPage() {
  const [week, setWeek] = useState(() => format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd'));
  useEffect(() => {
    const w = new URLSearchParams(window.location.search).get('week');
    if (w) setWeek(format(startOfWeek(parseISO(w), { weekStartsOn: 1 }), 'yyyy-MM-dd'));
  }, []);
  const { data, error, isLoading, mutate } = useSWR(`/api/me/timesheets?weekStart=${week}`, jsonFetcher);
  const { data: historyRes, mutate: refreshHistory } = useSWR('/api/me/timesheets/history', jsonFetcher);
  const sheet = data?.data;
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!confirm('Submit this week for approval? You will not be able to change its entries unless it is rejected.')) return;
    setBusy(true);
    try {
      await apiSend('/api/me/timesheets', 'POST', { weekStart: week });
      toast.success('Timesheet submitted');
      mutate(); refreshHistory();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const shift = (n: number) => setWeek((w) => format(addDays(parseISO(w), n * 7), 'yyyy-MM-dd'));
  const locked = sheet && ['submitted', 'approved'].includes(sheet.status);
  const byProject: Record<string, { name: string; days: Record<string, number>; total: number }> = {};
  (sheet?.entries || []).forEach((e: any) => {
    const p = byProject[e.project_id] || (byProject[e.project_id] = { name: e.project_name, days: {}, total: 0 });
    p.days[e.date] = Math.round(((p.days[e.date] || 0) + e.hours) * 100) / 100;
    p.total = Math.round((p.total + e.hours) * 100) / 100;
  });
  const dayKeys = sheet ? Object.keys(sheet.days) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><ClipboardCheck className="h-7 w-7" />My Timesheets</h1>
          <p className="text-gray-600 mt-1">Review your weekly hours and submit them for approval. Log hours on the <Link href="/time-entries" className="text-blue-600 underline">Time Entries</Link> page or with the task timer.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => shift(-1)}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="font-semibold w-48 text-center">Week of {formatDay(week)}</span>
          <Button variant="outline" size="icon" onClick={() => shift(1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              {sheet?.total ?? 0}h logged
              {sheet && <Badge className={`border-0 capitalize ${STATUS_CLS[sheet.status]}`}>{sheet.status}</Badge>}
              {locked && <Lock className="h-4 w-4 text-gray-400" />}
            </CardTitle>
            <CardDescription>
              {sheet?.status === 'approved' && `Approved${sheet.reviewer ? ` by ${sheet.reviewer}` : ''}`}
              {sheet?.status === 'rejected' && <span className="text-red-700">Rejected{sheet.reviewer ? ` by ${sheet.reviewer}` : ''}: {sheet.timesheet?.review_note}</span>}
              {sheet?.status === 'submitted' && 'Waiting for approval — entries for this week are locked'}
              {sheet?.status === 'draft' && 'Not submitted yet'}
            </CardDescription>
          </div>
          {sheet && !locked && <Button onClick={submit} disabled={busy || !sheet.total}><Send className="h-4 w-4 mr-1" />{busy ? 'Submitting…' : 'Submit for approval'}</Button>}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {error ? <p className="text-sm text-red-600">{errorMessage(error)}</p> : isLoading || !sheet ? <Skeleton className="h-32 w-full" /> : (
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b">
                  <th className="py-2">Project</th>
                  {dayKeys.map((d) => <th key={d} className="py-2 text-right">{format(parseISO(d), 'EEE d')}</th>)}
                  <th className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(byProject).length === 0 && <tr><td colSpan={9} className="py-6 text-center text-gray-500">No hours logged this week.</td></tr>}
                {Object.entries(byProject).map(([id, p]) => (
                  <tr key={id} className="border-b">
                    <td className="py-2"><Link href={`/projects/${id}`} className="hover:underline">{p.name}</Link></td>
                    {dayKeys.map((d) => <td key={d} className="py-2 text-right">{p.days[d] ? p.days[d] : <span className="text-gray-300">–</span>}</td>)}
                    <td className="py-2 text-right font-semibold">{p.total}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2">Total</td>
                  {dayKeys.map((d) => <td key={d} className="py-2 text-right">{sheet.days[d] || 0}</td>)}
                  <td className="py-2 text-right">{sheet.total}</td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-lg">History</CardTitle><CardDescription>Submitted weeks and approved hours</CardDescription></CardHeader>
        <CardContent>
          {(historyRes?.data || []).length === 0 ? <p className="text-sm text-gray-500">No timesheets submitted yet.</p> : (
            <ul className="divide-y">
              {(historyRes?.data || []).map((h: any) => (
                <li key={h.id} className="py-2 flex flex-wrap items-center gap-3 text-sm">
                  <button className="text-blue-600 hover:underline" onClick={() => setWeek(h.week_start_date)}>Week of {formatDay(h.week_start_date)}</button>
                  <Badge className={`border-0 capitalize ${STATUS_CLS[h.status]}`}>{h.status}</Badge>
                  <span>{h.total_hours ?? 0}h{h.status === 'approved' ? ' approved' : ''}</span>
                  {h.review_note && <span className="text-xs text-gray-500 italic">“{h.review_note}”</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
