'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { jsonFetcher, apiSend, apiGet, errorMessage, formatDay } from '@/lib/client-api';
import { LayoutTemplate, Trash2, Rocket } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function TemplatesPage() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR('/api/project-templates', jsonFetcher);
  const { data: accountsRes } = useSWR('/api/accounts', (url: string) => apiGet(url));
  const accounts: any[] = accountsRes?.accounts || accountsRes?.data || (Array.isArray(accountsRes) ? accountsRes : []);
  const templates: any[] = data?.data || [];
  const [using, setUsing] = useState<any | null>(null);
  const [form, setForm] = useState({ name: '', account_id: '', start_date: new Date().toISOString().slice(0, 10), end_date: '' });
  const [busy, setBusy] = useState(false);

  const remove = async (id: string) => {
    if (!confirm('Delete this template? Projects already created from it are not affected.')) return;
    try { await apiSend(`/api/project-templates/${id}`, 'DELETE'); mutate(); } catch (e) { toast.error(errorMessage(e)); }
  };
  const create = async () => {
    setBusy(true);
    try {
      const res = await apiSend('/api/projects/from-template', 'POST', { template_id: using.id, name: form.name, account_id: form.account_id, start_date: form.start_date, end_date: form.end_date || null });
      toast.success(`Project created with ${res.data.tasks} tasks and ${res.data.milestones} milestones`);
      router.push(`/projects/${res.data.project.id}`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><LayoutTemplate className="h-7 w-7" />Project Templates</h1>
        <p className="text-gray-600 mt-1">Create templates from any project (Project → Client & Settings → Save as template), then start new projects from them.</p>
      </div>
      {error && <p className="text-sm text-red-600">{errorMessage(error)}</p>}
      {isLoading ? <Skeleton className="h-40" /> : templates.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-gray-500">No templates yet.</CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {templates.map((t) => (
            <Card key={t.id}>
              <CardHeader>
                <CardTitle className="text-lg">{t.name}</CardTitle>
                <CardDescription>{t.description || 'No description'}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-gray-600">{t.task_count} tasks · {t.milestone_count} milestones · updated {formatDay(t.updated_at)}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => { setUsing(t); setForm((f) => ({ ...f, name: t.name.replace(/ template$/i, '') })); }}><Rocket className="h-4 w-4 mr-1" />Use template</Button>
                  <Button size="sm" variant="ghost" className="text-red-600" onClick={() => remove(t.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={!!using} onOpenChange={(o) => !o && setUsing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>New project from “{using?.name}”</DialogTitle><DialogDescription>Tasks, subtasks, milestones and dependencies are copied with dates shifted to the start date.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1"><Label>Project name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="space-y-1"><Label>Client account</Label>
              <Select value={form.account_id} onValueChange={(v) => setForm({ ...form, account_id: v })}>
                <SelectTrigger><SelectValue placeholder="Choose account" /></SelectTrigger>
                <SelectContent>{accounts.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label>Start date</Label><Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></div>
              <div className="space-y-1"><Label>End date (optional)</Label><Input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUsing(null)}>Cancel</Button>
            <Button onClick={create} disabled={busy || !form.name.trim() || !form.account_id || !form.start_date}>{busy ? 'Creating…' : 'Create project'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
