'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { format, subDays } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { jsonFetcher, errorMessage } from '@/lib/client-api';
import { downloadCsv } from '@/lib/csv';
import { Download, BarChart3 } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
const REPORTS = [
  { key: 'project-performance', label: 'Project performance', desc: 'Progress, overdue tasks, hours and delays per project' },
  { key: 'project-completion', label: 'Project completion', desc: 'Completion % and status of projects' },
  { key: 'employee-performance', label: 'Employee performance', desc: 'Tasks completed, on-time rate and hours per person (in range)' },
  { key: 'workload', label: 'Team workload', desc: 'Open, overdue and in-review tasks per person' },
  { key: 'time', label: 'Time tracking', desc: 'Hours per person and project (in range)' },
  { key: 'budget', label: 'Budget', desc: 'Budget, spend and remaining per project' },
  { key: 'risks', label: 'Risks & issues', desc: 'All risks and issues with severity and status' },
];

export default function ManagerReportsPage() {
  const [type, setType] = useState('project-performance');
  const [from, setFrom] = useState(format(subDays(new Date(), 90), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const { data, error, isLoading } = useSWR(`/api/manager/reports/${type}?from=${from}&to=${to}`, jsonFetcher);
  const rows: any[] = data?.data || [];
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const current = REPORTS.find((r) => r.key === type)!;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><BarChart3 className="h-7 w-7" />Reports</h1>
          <p className="text-gray-600 mt-1">Scoped to projects you manage. For organization-wide charts see <Link href="/analytics" className="text-blue-600 underline">Analytics</Link>.</p>
        </div>
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          <span className="text-gray-400">to</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {REPORTS.map((r) => <Button key={r.key} size="sm" variant={type === r.key ? 'default' : 'outline'} onClick={() => setType(r.key)}>{r.label}</Button>)}
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div><CardTitle className="text-lg">{current.label}</CardTitle><CardDescription>{current.desc}</CardDescription></div>
          <Button size="sm" variant="outline" disabled={!rows.length} onClick={() => downloadCsv(rows, `${type}-${from}-to-${to}`)}><Download className="h-4 w-4 mr-1" />Export CSV</Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {error ? <p className="text-sm text-red-600">{errorMessage(error)}</p> : isLoading ? <Skeleton className="h-48" /> : rows.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">No data for this report.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500 border-b">{headers.map((h) => <th key={h} className="py-2 pr-3 capitalize whitespace-nowrap">{h.replace(/_/g, ' ')}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i} className="border-b">{headers.map((h) => <td key={h} className="py-1.5 pr-3 whitespace-nowrap">{r[h] === null || r[h] === undefined || r[h] === '' ? '—' : String(r[h])}</td>)}</tr>)}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
