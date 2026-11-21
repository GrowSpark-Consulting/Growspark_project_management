'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { toast } from 'sonner';
import { addDays, format, parseISO, startOfWeek } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { jsonFetcher, apiSend, errorMessage, formatDay } from '@/lib/client-api';
import { ArrowLeft, ChevronLeft, ChevronRight, Save, Undo2, Users } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
const WEEKS = 6;
const STATUS: Record<string, { cls: string; label: string }> = {
  free: { cls: 'bg-gray-50 text-gray-500', label: 'Nothing planned' },
  ok: { cls: 'bg-green-50 text-green-800', label: 'Has room' },
  near: { cls: 'bg-amber-50 text-amber-800', label: 'Nearly full (90%+)' },
  over: { cls: 'bg-red-50 text-red-800', label: 'Over capacity' },
};
const hrs = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')} h`;
const thisMonday = () => format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');

export default function ResourcePlanPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [from, setFrom] = useState(thisMonday);
  const url = `/api/projects/${projectId}/allocations?from=${from}&weeks=${WEEKS}`;
  const { data, error, isLoading, mutate } = useSWR(url, jsonFetcher);
  const plan = data?.data;
  // Unsaved edits, kept per task and week (they survive moving between weeks until saved or discarded)
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const serverValue = (taskId: string, week: string): number => {
    for (const p of plan?.people || []) {
      const t = p.tasks.find((x: any) => x.id === taskId);
      if (t) return t.hours[week] ?? 0;
    }
    return 0;
  };
  const changes = useMemo(() => Object.entries(edits)
    .map(([key, value]) => { const [taskId, week] = key.split('|'); return { taskId, weekStartDate: week, hours: value.trim() === '' ? 0 : Number(value) }; })
    .filter((c) => Number.isFinite(c.hours)), [edits]);
  const invalid = Object.values(edits).some((v) => v.trim() !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 168));

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiSend(`/api/projects/${projectId}/allocations`, 'PUT', { changes, from, weeks: WEEKS });
      await mutate(res, { revalidate: false });
      setEdits({});
      toast.success('Resource plan saved');
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  const overloaded = (plan?.people || []).flatMap((p: any) => p.weeks.filter((w: any) => w.status === 'over').map((w: any) => ({ name: p.name, week: w.week })));
  const moveWeeks = (n: number) => setFrom((f) => format(addDays(parseISO(f), n * 7), 'yyyy-MM-dd'));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Link href={`/projects/${projectId}`} className="inline-flex items-center text-sm text-gray-600 hover:underline"><ArrowLeft className="h-4 w-4 mr-1" />{plan?.project?.name || 'Project'}</Link>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><Users className="h-7 w-7" />Resource plan</h1>
          <p className="text-gray-600">Plan each person&apos;s hours per task and week, and see whether they have room for it.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Earlier weeks" onClick={() => moveWeeks(-1)}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-sm font-medium text-center min-w-40">{plan ? `${formatDay(plan.weeks[0])} – ${formatDay(format(addDays(parseISO(plan.weeks[plan.weeks.length - 1]), 6), 'yyyy-MM-dd'))}` : '…'}</span>
          <Button variant="outline" size="icon" aria-label="Later weeks" onClick={() => moveWeeks(1)}><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => setFrom(thisMonday())}>This week</Button>
        </div>
      </div>

      {error ? (
        <Card><CardContent className="p-6 text-sm text-red-700">{errorMessage(error)}</CardContent></Card>
      ) : isLoading || !plan ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {(['ok', 'near', 'over'] as const).map((s) => <span key={s} className={`rounded px-2 py-0.5 ${STATUS[s].cls}`}>{STATUS[s].label}</span>)}
              <span className="text-gray-500">Person rows: hours on this project, then all planned hours against available hours (default {plan.defaultAvailable} h a week; set in <Link href="/capacity" className="underline">Capacity</Link>).</span>
            </div>
            {plan.canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                {invalid && <span role="alert" className="text-sm text-red-700">Hours must be between 0 and 168.</span>}
                <span className="text-sm text-gray-600" aria-live="polite">{changes.length ? `${changes.length} unsaved change${changes.length === 1 ? '' : 's'}` : 'No unsaved changes'}</span>
                <Button variant="outline" onClick={() => setEdits({})} disabled={!changes.length || saving}><Undo2 className="h-4 w-4 mr-1" />Discard</Button>
                <Button onClick={save} disabled={!changes.length || invalid || saving}><Save className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Save plan'}</Button>
              </div>
            )}
          </div>

          {!plan.canEdit && (
            <p className="rounded-md bg-gray-50 border px-3 py-2 text-sm text-gray-700">This project is {plan.project.archived ? 'archived' : 'complete'}, so the plan is read-only.</p>
          )}
          {overloaded.length > 0 && (
            <p role="status" className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-800">
              Over capacity: {overloaded.map((o: any) => `${o.name} (week of ${formatDay(o.week)})`).join(', ')}.
            </p>
          )}

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              {plan.people.length === 0 ? (
                <p className="p-6 text-sm text-gray-600">Nobody is on this project yet. Add people to the project team, then assign them tasks to plan their hours.</p>
              ) : (
                <table className="w-full text-sm min-w-[760px]">
                  <thead>
                    <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
                      <th scope="col" className="p-2 w-64">Person / task</th>
                      {plan.weeks.map((w: string) => <th scope="col" key={w} className="p-2 text-center whitespace-nowrap">Week of {format(parseISO(w), 'd MMM')}</th>)}
                      <th scope="col" className="p-2 text-right whitespace-nowrap">Planned / estimate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.people.map((p: any) => (
                      <Fragment key={p.id}>
                        <tr className="border-b bg-white" data-person={p.id}>
                          <th scope="row" className="p-2 text-left font-semibold">{p.name}</th>
                          {p.weeks.map((w: any) => (
                            <td key={w.week} className="p-1 text-center">
                              <div className={`rounded px-1 py-1 ${STATUS[w.status].cls}`} data-week={w.week} data-status={w.status}
                                title={`${hrs(w.here)} on this project, ${hrs(w.other)} on other projects, ${hrs(w.available)} available`}>
                                <div className="font-medium">{hrs(w.here)}</div>
                                <div className="text-[11px] tabular-nums">{w.total} / {w.available} h</div>
                              </div>
                            </td>
                          ))}
                          <td />
                        </tr>
                        {p.tasks.length === 0 && (
                          <tr className="border-b"><td colSpan={plan.weeks.length + 2} className="px-6 py-2 text-xs text-gray-500">No open tasks assigned on this project.</td></tr>
                        )}
                        {p.tasks.map((t: any) => {
                          const planned = plan.weeks.reduce((s: number, w: string) => s - (t.hours[w] ?? 0) + (edits[`${t.id}|${w}`] !== undefined ? Number(edits[`${t.id}|${w}`]) || 0 : t.hours[w] ?? 0), t.planned_total);
                          const overEstimate = t.estimated_hours != null && planned > t.estimated_hours;
                          return (
                            <tr key={t.id} className="border-b">
                              <td className="py-1 pl-6 pr-2">
                                <div className="truncate max-w-56" title={t.name}>{t.is_subtask ? '↳ ' : ''}{t.name}</div>
                                {t.due_date && <div className="text-[11px] text-gray-500">Due {formatDay(t.due_date)}</div>}
                              </td>
                              {plan.weeks.map((w: string) => {
                                const key = `${t.id}|${w}`;
                                const value = edits[key] ?? (t.hours[w] ? String(t.hours[w]) : '');
                                const dirty = edits[key] !== undefined;
                                return (
                                  <td key={w} className="p-1 text-center">
                                    <input
                                      id={`alloc-${t.id}-${w}`}
                                      type="number" min={0} max={168} step={0.5} inputMode="decimal"
                                      aria-label={`${t.name}, week of ${formatDay(w)}, hours`}
                                      className={`w-16 rounded border px-1 py-0.5 text-center tabular-nums ${dirty ? 'border-amber-400 bg-amber-50' : 'border-gray-200'} disabled:bg-gray-50`}
                                      value={value} placeholder="0" disabled={!plan.canEdit || saving}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setEdits((prev) => {
                                          const next = { ...prev };
                                          if ((Number(v) || 0) === serverValue(t.id, w)) delete next[key]; else next[key] = v;
                                          return next;
                                        });
                                      }}
                                    />
                                  </td>
                                );
                              })}
                              <td className={`p-2 text-right whitespace-nowrap tabular-nums ${overEstimate ? 'text-amber-700' : 'text-gray-600'}`} title={overEstimate ? 'More hours planned than estimated' : undefined}>
                                {hrs(planned)} / {t.estimated_hours != null ? hrs(t.estimated_hours) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {plan.unassigned.length > 0 && (
            <Card>
              <CardContent className="p-4 space-y-2 text-sm">
                <p className="font-medium">Not assigned yet ({plan.unassigned.length})</p>
                <p className="text-gray-600">Assign these tasks to someone on the project to plan their hours.</p>
                <div className="flex flex-wrap gap-2">{plan.unassigned.map((t: any) => <Badge key={t.id} variant="outline">{t.name}</Badge>)}</div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
