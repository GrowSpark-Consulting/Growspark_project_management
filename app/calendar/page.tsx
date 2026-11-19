'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import {
  addDays, addMonths, addWeeks, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths, subWeeks,
} from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { jsonFetcher, errorMessage } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import { CalendarDays, ChevronLeft, ChevronRight, Flag, CheckSquare, FolderOpen } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Item = { key: string; date: string; label: string; kind: 'task' | 'milestone' | 'project'; href: string; done?: boolean };

export default function CalendarPage() {
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [cursor, setCursor] = useState(new Date());

  const range = useMemo(() => {
    if (mode === 'week') {
      const s = startOfWeek(cursor, { weekStartsOn: 1 });
      return { start: s, end: endOfWeek(cursor, { weekStartsOn: 1 }) };
    }
    return { start: startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), end: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) };
  }, [mode, cursor]);
  const from = format(range.start, 'yyyy-MM-dd');
  const to = format(range.end, 'yyyy-MM-dd');
  const { data, error, isLoading } = useSWR(`/api/me/calendar?from=${from}&to=${to}`, jsonFetcher);
  const payload = data?.data;

  const items: Item[] = useMemo(() => {
    if (!payload) return [];
    return [
      ...payload.tasks.map((t: any) => ({ key: `t${t.id}`, date: t.due_date.slice(0, 10), label: t.name, kind: 'task' as const, href: `/projects/${t.project_id}?task=${t.id}`, done: t.status === 'done' })),
      ...payload.milestones.map((m: any) => ({ key: `m${m.id}`, date: m.date.slice(0, 10), label: `${m.name} (${m.project_name})`, kind: 'milestone' as const, href: `/projects/${m.project_id}`, done: m.status === 'completed' })),
      ...payload.projectDeadlines.map((p: any) => ({ key: `p${p.id}`, date: p.end_date.slice(0, 10), label: `${p.name} deadline`, kind: 'project' as const, href: `/projects/${p.id}`, done: p.status === 'complete' })),
    ];
  }, [payload]);

  const availabilityFor = (day: Date): number | null => {
    if (!payload) return null;
    const weekKey = format(startOfWeek(day, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    const row = payload.availability.find((a: any) => a.week_start_date === weekKey);
    if (!row) return null;
    const dayName = format(day, 'EEEE').toLowerCase();
    const perDay = row.schedule_data?.[dayName] ?? row.schedule_data?.hoursPerDay?.[dayName];
    return typeof perDay === 'number' ? perDay : null;
  };

  const days: Date[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) days.push(d);
  const today = new Date();

  const move = (dir: 1 | -1) => setCursor((c) => (mode === 'month' ? (dir === 1 ? addMonths(c, 1) : subMonths(c, 1)) : (dir === 1 ? addWeeks(c, 1) : subWeeks(c, 1))));
  const icon = (k: Item['kind']) => (k === 'task' ? CheckSquare : k === 'milestone' ? Flag : FolderOpen);
  const color = (k: Item['kind']) => (k === 'task' ? 'bg-blue-50 text-blue-800 border-blue-200' : k === 'milestone' ? 'bg-purple-50 text-purple-800 border-purple-200' : 'bg-amber-50 text-amber-800 border-amber-200');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><CalendarDays className="h-7 w-7" />My Calendar</h1>
          <p className="text-gray-600 mt-1">Task deadlines, project deadlines, milestones and your availability</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => move(-1)}><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
          <Button variant="outline" size="icon" onClick={() => move(1)}><ChevronRight className="h-4 w-4" /></Button>
          <span className="font-semibold w-44 text-center">{mode === 'month' ? format(cursor, 'MMMM yyyy') : `${format(range.start, 'MMM d')} – ${format(range.end, 'MMM d, yyyy')}`}</span>
          <div className="flex border rounded-md">
            <Button size="sm" variant={mode === 'week' ? 'default' : 'ghost'} onClick={() => setMode('week')}>Week</Button>
            <Button size="sm" variant={mode === 'month' ? 'default' : 'ghost'} onClick={() => setMode('month')}>Month</Button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        <span className="flex items-center gap-1"><CheckSquare className="h-3 w-3 text-blue-600" />My task deadline</span>
        <span className="flex items-center gap-1"><Flag className="h-3 w-3 text-purple-600" />Milestone</span>
        <span className="flex items-center gap-1"><FolderOpen className="h-3 w-3 text-amber-600" />Project deadline</span>
        <span className="text-gray-500">Small number = your available hours that day</span>
      </div>

      {error && <p className="text-sm text-red-600">{errorMessage(error)}</p>}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <div className="grid grid-cols-7 min-w-[700px] border-b bg-gray-50 text-xs font-medium text-gray-600">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="p-2">{d}</div>)}
          </div>
          <div className={cn('grid grid-cols-7 min-w-[700px]', isLoading && 'opacity-60')}>
            {days.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              const dayItems = items.filter((i) => i.date === key);
              const avail = availabilityFor(day);
              return (
                <div key={key} className={cn('border-r border-b p-1.5', mode === 'month' ? 'min-h-[110px]' : 'min-h-[320px]', mode === 'month' && !isSameMonth(day, cursor) && 'bg-gray-50/70 text-gray-400')}>
                  <div className="flex items-center justify-between">
                    <span className={cn('text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full', isSameDay(day, today) && 'bg-blue-600 text-white')}>{format(day, 'd')}</span>
                    {avail != null && <span className="text-[10px] text-gray-400">{avail}h</span>}
                  </div>
                  <div className="space-y-1 mt-1">
                    {dayItems.map((i) => {
                      const Icon = icon(i.kind);
                      return (
                        <Link key={i.key} href={i.href} title={i.label}
                          className={cn('flex items-center gap-1 rounded border px-1 py-0.5 text-[11px] truncate', color(i.kind), i.done && 'line-through opacity-60')}>
                          <Icon className="h-3 w-3 flex-shrink-0" /><span className="truncate">{i.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
