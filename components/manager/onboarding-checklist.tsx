'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { CheckCircle2, Circle, MinusCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { jsonFetcher, apiSend, errorMessage } from '@/lib/client-api';

type Step = { key: string; title: string; description: string; href: string; optional: boolean; done: boolean; skipped: boolean };
type Status = { visible: boolean; steps?: Step[]; completed?: number; total?: number; finished?: boolean; dismissed?: boolean };

/** Workspace setup checklist on the Manager dashboard (workspace owner only). Every step can be skipped. */
export function OnboardingChecklist() {
  const { data, mutate } = useSWR('/api/manager/onboarding', jsonFetcher);
  const st: Status | undefined = data?.data;
  if (!st?.visible || !st.steps) return null;

  const act = async (action: string, step?: string) => {
    try {
      const res = await apiSend('/api/manager/onboarding', 'POST', { action, step });
      mutate({ data: res.data ?? res }, { revalidate: true });
    } catch (e) { toast.error(errorMessage(e)); }
  };

  if (st.dismissed) {
    return st.finished ? null : (
      <button className="text-xs text-ink-muted underline" onClick={() => act('reopen')}>Show the workspace setup checklist ({st.completed}/{st.total} done)</button>
    );
  }

  const pct = Math.round(((st.completed || 0) / (st.total || 1)) * 100);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>{st.finished ? 'Your workspace is ready' : 'Set up your workspace'}</CardTitle>
          <CardDescription>{st.finished ? 'Everything is set up. You can hide this checklist.' : `${st.completed} of ${st.total} done. Skip anything you want to do later.`}</CardDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={() => act('dismiss')}>{st.finished ? 'Start using the system' : 'Hide'}</Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={pct} aria-label={`Workspace setup ${pct}% complete`} />
        <ol className="divide-y divide-line">
          {st.steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-3 py-2.5">
              {s.done ? <CheckCircle2 className="h-5 w-5 flex-none text-success" aria-label="Done" />
                : s.skipped ? <MinusCircle className="h-5 w-5 flex-none text-ink-muted" aria-label="Skipped" />
                : <Circle className="h-5 w-5 flex-none text-ink-muted" aria-label="To do" />}
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${s.done || s.skipped ? 'text-ink-muted' : 'text-ink'}`}>
                  {i + 1}. {s.title}{s.optional && !s.done ? <span className="ml-1 text-xs font-normal text-ink-muted">(optional)</span> : null}
                </p>
                <p className="text-xs text-ink-muted">{s.description}</p>
              </div>
              {!s.done && (
                <div className="flex flex-none items-center gap-1">
                  {s.skipped
                    ? <Button size="sm" variant="ghost" onClick={() => act('unskip', s.key)}>Undo skip</Button>
                    : <>
                        <Button size="sm" asChild><Link href={s.href}>Start</Link></Button>
                        <Button size="sm" variant="ghost" onClick={() => act('skip', s.key)}>Skip</Button>
                      </>}
                </div>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
