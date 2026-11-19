'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ClientDeliverables } from '@/components/client/client-project-extras';
import { jsonFetcher, formatDay } from '@/lib/client-api';
import { ClipboardCheck } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function ClientApprovalsPage() {
  const { data: summary } = useSWR('/api/client/portal/summary', jsonFetcher);
  const { data: history, isLoading } = useSWR('/api/client/portal/approvals/history', jsonFetcher);
  const steps: any[] = summary?.data?.pendingSteps || [];
  const rows: any[] = history?.data || [];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ClipboardCheck className="h-6 w-6" />Approvals</h1>
        <p className="text-sm text-muted-foreground">Review deliverables and project stages that need your decision</p>
      </div>

      {steps.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Project stages waiting for you</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {steps.map((s) => (
              <Link key={s.project_id} href={`/client-portal/projects/${s.project_id}`} className="flex justify-between text-sm hover:underline">
                <span>{s.project_name}</span><span className="text-muted-foreground">{s.label}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Deliverables</h2>
        <ClientDeliverables />
      </section>

      <Card>
        <CardHeader><CardTitle className="text-base">Approval history</CardTitle><CardDescription>Decisions made on your account</CardDescription></CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-20" /> : rows.length === 0 ? <p className="text-sm text-muted-foreground">No decisions yet.</p> : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={`${r.type}${r.id}`} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                  <Badge className={`border-0 ${r.decision === 'approved' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{r.decision === 'approved' ? 'Approved' : 'Changes requested'}</Badge>
                  <span className="font-medium">{r.item}</span>
                  <Link href={`/client-portal/projects/${r.project_id}`} className="text-muted-foreground hover:underline">{r.project_name}</Link>
                  <span className="text-xs text-muted-foreground ml-auto">{r.decided_by} · {formatDay(r.decided_at)}</span>
                  {r.comment && <p className="w-full text-xs italic text-muted-foreground">“{r.comment}”</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
