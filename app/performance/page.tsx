'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { jsonFetcher, errorMessage, formatDay } from '@/lib/client-api';
import { Trophy } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function PerformancePage() {
  const [weeks, setWeeks] = useState(12);
  const { data, error, isLoading } = useSWR(`/api/me/performance?weeks=${weeks}`, jsonFetcher);
  const p = data?.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><Trophy className="h-7 w-7" />My Performance</h1>
          <p className="text-gray-600 mt-1">Your completed work, hours and contribution per project</p>
        </div>
        <div className="flex gap-1">
          {[4, 12, 26].map((w) => <Button key={w} size="sm" variant={weeks === w ? 'default' : 'outline'} onClick={() => setWeeks(w)}>{w} weeks</Button>)}
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{errorMessage(error)}</p>}
      {isLoading || !p ? <Skeleton className="h-64 w-full" /> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Kpi label="Tasks completed" value={p.tasksCompleted} />
            <Kpi label="Tasks pending" value={p.tasksPending} />
            <Kpi label="On-time rate" value={p.onTimeRate == null ? '—' : `${p.onTimeRate}%`} />
            <Kpi label={`Hours (${weeks} wks)`} value={p.hoursLogged} />
            <Kpi label="Avg hours / week" value={p.avgHoursPerWeek} />
          </div>
          <Card>
            <CardHeader><CardTitle className="text-lg">Weekly productivity</CardTitle><CardDescription>Tasks completed and hours logged per week</CardDescription></CardHeader>
            <CardContent>
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={p.weekly.map((w: any) => ({ ...w, label: formatDay(w.week).replace(/, \d{4}$/, '') }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" fontSize={11} />
                    <YAxis yAxisId="h" fontSize={11} />
                    <YAxis yAxisId="t" orientation="right" allowDecimals={false} fontSize={11} />
                    <Tooltip />
                    <Legend />
                    <Bar yAxisId="h" dataKey="hours" name="Hours" fill="#3b82f6" />
                    <Bar yAxisId="t" dataKey="tasksDone" name="Tasks done" fill="#10b981" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-lg">Project contributions</CardTitle></CardHeader>
            <CardContent>
              {p.byProject.length === 0 ? <p className="text-sm text-gray-500">No contributions in this period.</p> : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-gray-500 border-b"><th className="py-2">Project</th><th className="py-2 text-right">Hours</th><th className="py-2 text-right">Tasks done</th></tr></thead>
                  <tbody>{p.byProject.map((r: any) => (
                    <tr key={r.project_id} className="border-b"><td className="py-2">{r.project_name}</td><td className="py-2 text-right">{r.hours}</td><td className="py-2 text-right">{r.tasksDone}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return <Card><CardContent className="p-4"><div className="text-xs text-gray-500">{label}</div><div className="text-2xl font-bold">{value}</div></CardContent></Card>;
}
