'use client';

import { useEffect, useState } from 'react';
import { useCursorFeed } from '@/lib/hooks/use-cursor-feed';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { jsonFetcher, apiSend, apiUpload, errorMessage, formatBytes, formatDay, formatMoney, timeAgo } from '@/lib/client-api';
import {
  Flag, PackageCheck, FolderOpen, ShieldAlert, Wallet, Settings2, Download, Trash2, Upload, Share2, Archive,
  ArchiveRestore, MessageSquareHeart, LayoutTemplate, CheckCircle2, Circle, ExternalLink,
} from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DELIVERABLE_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-gray-100 text-gray-800' },
  pending_review: { label: 'Awaiting internal review', cls: 'bg-amber-100 text-amber-800' },
  client_review: { label: 'With client', cls: 'bg-blue-100 text-blue-800' },
  approved: { label: 'Approved by client', cls: 'bg-green-100 text-green-800' },
  rejected: { label: 'Rejected by client', cls: 'bg-red-100 text-red-800' },
  revised: { label: 'Revised', cls: 'bg-purple-100 text-purple-800' },
};

export default function ProjectExtras({ projectId, onChanged }: { projectId: string; project?: any; tasks?: any[]; onChanged?: () => void }) {
  const { data: accessRes, mutate: refreshAccess } = useSWR(`/api/projects/${projectId}/access`, jsonFetcher);
  const access = accessRes?.data;
  if (!access) return null;
  const readOnly = access.project.status === 'complete' || !!access.project.archived_at;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Flag className="w-5 h-5 text-blue-600" />Planning, Deliverables & Documents</CardTitle>
        <CardDescription>
          {access.project.archived_at ? 'This project is archived (read-only).' : 'Milestones, deliverables for client review, documents, risks and budget'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="milestones">
          <TabsList className="flex flex-wrap h-auto">
            <TabsTrigger value="milestones"><Flag className="h-3.5 w-3.5 mr-1" />Milestones</TabsTrigger>
            <TabsTrigger value="deliverables"><PackageCheck className="h-3.5 w-3.5 mr-1" />Deliverables</TabsTrigger>
            <TabsTrigger value="files"><FolderOpen className="h-3.5 w-3.5 mr-1" />Documents</TabsTrigger>
            <TabsTrigger value="risks"><ShieldAlert className="h-3.5 w-3.5 mr-1" />Risks</TabsTrigger>
            {access.canSeeBudget && <TabsTrigger value="budget"><Wallet className="h-3.5 w-3.5 mr-1" />Budget</TabsTrigger>}
            {access.canManage && <TabsTrigger value="settings"><Settings2 className="h-3.5 w-3.5 mr-1" />Client & Settings</TabsTrigger>}
          </TabsList>
          <TabsContent value="milestones"><Milestones projectId={projectId} access={access} readOnly={readOnly} /></TabsContent>
          <TabsContent value="deliverables"><Deliverables projectId={projectId} access={access} readOnly={readOnly} /></TabsContent>
          <TabsContent value="files"><Documents projectId={projectId} access={access} /></TabsContent>
          <TabsContent value="risks"><Risks projectId={projectId} access={access} readOnly={readOnly} /></TabsContent>
          {access.canSeeBudget && <TabsContent value="budget"><Budget projectId={projectId} access={access} onSaved={refreshAccess} /></TabsContent>}
          {access.canManage && (
            <TabsContent value="settings">
              <SettingsTab projectId={projectId} access={access} onSaved={() => { refreshAccess(); onChanged?.(); }} />
            </TabsContent>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Milestones({ projectId, access, readOnly }: { projectId: string; access: any; readOnly: boolean }) {
  const { data, mutate } = useSWR(`/api/projects/${projectId}/milestones`, jsonFetcher);
  const [form, setForm] = useState({ name: '', date: '', client_visible: true });
  const items: any[] = data?.data || [];
  const can = access.canManage && !readOnly;

  const add = async () => {
    try {
      await apiSend(`/api/projects/${projectId}/milestones`, 'POST', form);
      setForm({ name: '', date: '', client_visible: true });
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const patch = async (id: string, body: any) => {
    try { await apiSend(`/api/milestones/${id}`, 'PATCH', body); mutate(); } catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async (id: string) => {
    if (!confirm('Delete this milestone?')) return;
    try { await apiSend(`/api/milestones/${id}`, 'DELETE'); mutate(); } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-3 pt-2">
      {items.length === 0 && <p className="text-sm text-gray-500">No milestones yet.</p>}
      {items.map((m) => (
        <div key={m.id} className="flex flex-wrap items-center gap-2 rounded border p-2">
          <button disabled={!can} onClick={() => patch(m.id, { status: m.status === 'completed' ? 'pending' : 'completed' })} title="Toggle completed">
            {m.status === 'completed' ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <Circle className="h-5 w-5 text-gray-400" />}
          </button>
          <span className={`flex-1 text-sm ${m.status === 'completed' ? 'line-through text-gray-500' : ''}`}>{m.name}</span>
          <span className="text-xs text-gray-500">{formatDay(m.date)}</span>
          {can ? (
            <label className="flex items-center gap-1 text-xs text-gray-600">
              <Switch checked={m.client_visible} onCheckedChange={(v) => patch(m.id, { client_visible: v })} />Client
            </label>
          ) : m.client_visible && <Badge variant="outline" className="text-xs">Visible to client</Badge>}
          {can && <button onClick={() => remove(m.id)} className="text-red-500"><Trash2 className="h-4 w-4" /></button>}
        </div>
      ))}
      {can && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px_auto_auto] gap-2 items-center">
          <Input placeholder="Milestone name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={200} />
          <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <label className="flex items-center gap-1 text-xs"><Switch checked={form.client_visible} onCheckedChange={(v) => setForm({ ...form, client_visible: v })} />Client</label>
          <Button onClick={add} disabled={!form.name.trim() || !form.date}>Add</Button>
        </div>
      )}
    </div>
  );
}

function Deliverables({ projectId, access, readOnly }: { projectId: string; access: any; readOnly: boolean }) {
  const { data, mutate } = useSWR(`/api/projects/${projectId}/deliverables`, jsonFetcher);
  const [form, setForm] = useState({ name: '', description: '', file_url: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const items: any[] = data?.data || [];

  const create = async () => {
    setBusy(true);
    try {
      let file_id: string | undefined;
      if (file) {
        const up = await apiUpload(`/api/projects/${projectId}/files`, file);
        file_id = up.data.id;
      }
      await apiSend(`/api/projects/${projectId}/deliverables`, 'POST', { ...form, file_url: form.file_url || null, file_id });
      setForm({ name: '', description: '', file_url: '' }); setFile(null);
      mutate();
      toast.success('Deliverable created as draft');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const act = async (id: string, action: 'submit' | 'share' | 'return') => {
    let note: string | null = null;
    if (action === 'return') note = prompt('Note for the team (optional)') || null;
    try {
      await apiSend(`/api/deliverables/${id}/action`, 'POST', { action, note });
      toast.success(action === 'share' ? 'Shared with client' : action === 'submit' ? 'Submitted for review' : 'Returned to draft');
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async (id: string) => {
    if (!confirm('Delete this deliverable?')) return;
    try { await apiSend(`/api/deliverables/${id}`, 'DELETE'); mutate(); } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-3 pt-2">
      {items.length === 0 && <p className="text-sm text-gray-500">No deliverables yet. Create one, submit it for review, and a manager shares it with the client.</p>}
      {items.map((d) => {
        const st = DELIVERABLE_STATUS[d.status] || DELIVERABLE_STATUS.draft;
        return (
          <div key={d.id} className="rounded border p-3 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-sm flex-1">{d.name} <span className="text-xs text-gray-400">v{d.version || 1}</span></span>
              <Badge className={`text-xs border-0 ${st.cls}`}>{st.label}</Badge>
            </div>
            {d.description && <p className="text-xs text-gray-600">{d.description}</p>}
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {d.file && <a className="text-blue-600 flex items-center gap-1" href={`/api/files/${d.file.id}`}><Download className="h-3 w-3" />{d.file.file_name}</a>}
              {d.file_url && <a className="text-blue-600 flex items-center gap-1" href={d.file_url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />Link</a>}
              {d.submitted_by_name && <span className="text-gray-500">By {d.submitted_by_name}</span>}
              {d.feedback && <span className="text-gray-600 italic">“{d.feedback}”</span>}
            </div>
            {!readOnly && (
              <div className="flex flex-wrap gap-2 pt-1">
                {['draft', 'revised', 'rejected'].includes(d.status) && access.canContribute && <Button size="sm" variant="outline" onClick={() => act(d.id, 'submit')}>Submit for review</Button>}
                {d.status === 'pending_review' && access.canManage && (
                  <>
                    <Button size="sm" onClick={() => act(d.id, 'share')} disabled={!access.project.shared_with_client}><Share2 className="h-3.5 w-3.5 mr-1" />Approve & share with client</Button>
                    <Button size="sm" variant="outline" onClick={() => act(d.id, 'return')}>Return to team</Button>
                  </>
                )}
                {d.status === 'client_review' && access.canManage && <Button size="sm" variant="outline" onClick={() => act(d.id, 'return')}>Withdraw from client</Button>}
                {(access.canManage || d.status === 'draft') && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => remove(d.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}
              </div>
            )}
          </div>
        );
      })}
      {access.canContribute && !readOnly && (
        <div className="rounded border border-dashed p-3 space-y-2">
          <Input placeholder="Deliverable name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={200} />
          <Textarea rows={2} placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Input placeholder="Link (optional, https://…)" value={form.file_url} onChange={(e) => setForm({ ...form, file_url: e.target.value })} />
            <Input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </div>
          <Button size="sm" onClick={create} disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : 'Create deliverable'}</Button>
        </div>
      )}
      {access.canManage && !access.project.shared_with_client && (
        <p className="text-xs text-amber-700">This project is not shared with the client. Enable it under Client & Settings to share deliverables.</p>
      )}
    </div>
  );
}

function Documents({ projectId, access }: { projectId: string; access: any }) {
  // Newest 20 first, older ones on "Load more" (keyset pages on the server)
  const feed = useCursorFeed<any, any>(
    `/api/projects/${projectId}/files`,
    (body) => ({ items: body?.data || [], nextCursor: body?.meta?.nextCursor ?? null, hasMore: !!body?.meta?.hasMore }),
    jsonFetcher,
  );
  const mutate = feed.refresh;
  const [uploading, setUploading] = useState(false);
  const files: any[] = feed.items;
  const upload = async (f?: File) => {
    if (!f) return;
    setUploading(true);
    try { await apiUpload(`/api/projects/${projectId}/files`, f); mutate(); toast.success('Uploaded'); } catch (e) { toast.error(errorMessage(e)); } finally { setUploading(false); }
  };
  const share = async (id: string, v: boolean) => {
    try { await apiSend(`/api/files/${id}`, 'PATCH', { client_visible: v }); mutate(); } catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async (id: string) => {
    if (!confirm('Delete this file?')) return;
    try { await apiSend(`/api/files/${id}`, 'DELETE'); mutate(); } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div className="space-y-2 pt-2">
      {files.length === 0 && <p className="text-sm text-gray-500">No documents yet.</p>}
      {files.map((f) => (
        <div key={f.id} className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
          <span className="flex-1 truncate">{f.file_name}{f.task_id && <span className="ml-1 text-xs text-gray-400">(task attachment)</span>}</span>
          <span className="text-xs text-gray-400">{formatBytes(f.size_bytes)} · {f.uploader?.name || ''}{f.uploader?.is_client ? ' (client)' : ''} · {timeAgo(f.created_at)}</span>
          {access.canManage ? (
            <label className="flex items-center gap-1 text-xs"><Switch checked={f.client_visible} onCheckedChange={(v) => share(f.id, v)} />Shared</label>
          ) : f.client_visible && <Badge variant="outline" className="text-xs">Shared with client</Badge>}
          <a href={`/api/files/${f.id}`} className="text-blue-600"><Download className="h-4 w-4" /></a>
          {(access.canManage || f.uploaded_by === access.me) && <button onClick={() => remove(f.id)} className="text-red-500"><Trash2 className="h-4 w-4" /></button>}
        </div>
      ))}
      {feed.hasMore && (
        <Button size="sm" variant="outline" onClick={() => feed.loadMore()} disabled={feed.loadingMore}>
          {feed.loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
      {access.canContribute && (
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer text-blue-600">
          <Upload className="h-4 w-4" />{uploading ? 'Uploading…' : 'Upload document (max 10 MB)'}
          <input type="file" className="hidden" disabled={uploading} onChange={(e) => upload(e.target.files?.[0])} />
        </label>
      )}
    </div>
  );
}

function Risks({ projectId, access, readOnly }: { projectId: string; access: any; readOnly: boolean }) {
  const { data, mutate } = useSWR(`/api/projects/${projectId}/issues?kind=risk`, async (url: string) => (await fetch(url)).json());
  const [form, setForm] = useState({ title: '', content: '', severity: 'medium' });
  const risks: any[] = data?.issues || [];
  const add = async () => {
    try {
      await apiSend(`/api/projects/${projectId}/issues`, 'POST', { ...form, kind: 'risk', content: form.content || form.title });
      setForm({ title: '', content: '', severity: 'medium' });
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const setStatus = async (id: string, status: string) => {
    try { await apiSend(`/api/projects/${projectId}/issues/${id}`, 'PUT', { status }); mutate(); } catch (e) { toast.error(errorMessage(e)); }
  };
  const sevCls = (s: string) => s === 'critical' ? 'bg-red-600 text-white' : s === 'high' ? 'bg-red-100 text-red-800' : s === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-800';
  return (
    <div className="space-y-2 pt-2">
      {risks.length === 0 && <p className="text-sm text-gray-500">No risks recorded.</p>}
      {risks.map((r) => (
        <div key={r.id} className="rounded border p-2 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`text-xs border-0 capitalize ${sevCls(r.severity)}`}>{r.severity}</Badge>
            <span className="flex-1 text-sm font-medium">{r.title || r.content.slice(0, 80)}</span>
            {access.canContribute && !readOnly ? (
              <Select value={r.status} onValueChange={(v) => setStatus(r.id, v)}>
                <SelectTrigger className="w-36 h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem><SelectItem value="in_progress">Mitigating</SelectItem><SelectItem value="resolved">Closed</SelectItem>
                </SelectContent>
              </Select>
            ) : <Badge variant="outline">{r.status}</Badge>}
          </div>
          {r.title && r.content && r.content !== r.title && <p className="text-xs text-gray-600">{r.content}</p>}
        </div>
      ))}
      {access.canContribute && !readOnly && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-2">
          <Input placeholder="Risk title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} />
          <Select value={form.severity} onValueChange={(v) => setForm({ ...form, severity: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{['low', 'medium', 'high', 'critical'].map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={add} disabled={!form.title.trim()}>Add risk</Button>
          <Textarea className="sm:col-span-3" rows={2} placeholder="Impact and mitigation (optional)" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        </div>
      )}
    </div>
  );
}

function Budget({ projectId, access, onSaved }: { projectId: string; access: any; onSaved: () => void }) {
  const { data, mutate } = useSWR(`/api/projects/${projectId}/budget`, jsonFetcher);
  const b = data?.data;
  // Budget is not part of the project payload (G-6); it comes from the manager-only budget endpoint
  const [form, setForm] = useState<{ budget: string | number; hourly_rate: string | number; currency: string }>({ budget: '', hourly_rate: '', currency: '' });
  const [formLoaded, setFormLoaded] = useState(false);
  useEffect(() => {
    if (b && !formLoaded) {
      setForm({ budget: b.budget ?? '', hourly_rate: b.project_hourly_rate ?? '', currency: b.currency || 'INR' });
      setFormLoaded(true);
    }
  }, [b, formLoaded]);
  const save = async () => {
    try {
      await apiSend(`/api/projects/${projectId}`, 'PATCH', {
        budget: form.budget === '' ? null : Number(form.budget),
        hourly_rate: form.hourly_rate === '' ? null : Number(form.hourly_rate),
        currency: (form.currency || 'INR').trim().toUpperCase(),
      });
      toast.success('Budget saved');
      mutate(); onSaved();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const pct = b?.percent_used ?? 0;
  const bar = b?.status === 'over' ? 'bg-danger' : b?.status === 'warning' ? 'bg-warning' : 'bg-success';
  const money = (v: number | null | undefined) => formatMoney(v, b?.currency || 'INR');
  return (
    <div className="space-y-3 pt-2">
      {b && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Stat label="Budget" value={b.budget != null ? money(b.budget) : 'Not set'} />
          <Stat label="Spent (hours × rate)" value={money(b.spent)} />
          <Stat label="Remaining" value={b.remaining != null ? money(b.remaining) : '—'} />
          <Stat label="Hours logged" value={`${b.logged_hours}h${b.estimated_hours ? ` / ${b.estimated_hours}h est.` : ''}`} />
        </div>
      )}
      {b?.percent_used != null && (
        <div>
          <div className="h-2 rounded-full bg-sunken"><div className={`h-2 rounded-full ${bar}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
          <p className="text-[13px] text-ink-muted mt-1">{pct}% of budget used{b.status === 'over' ? ' (over budget)' : b.status === 'warning' ? ' (approaching budget)' : ''}</p>
        </div>
      )}
      {access.canManage && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_120px_auto] gap-3 items-end">
          <div className="space-y-1"><Label>Budget</Label><Input type="number" min={0} step="0.01" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} /></div>
          <div className="space-y-1"><Label>Hourly rate (blank = company default {money(b?.default_hourly_rate)})</Label><Input type="number" min={0} step="0.01" value={form.hourly_rate} onChange={(e) => setForm({ ...form, hourly_rate: e.target.value })} /></div>
          <div className="space-y-1"><Label>Currency</Label><Input value={form.currency} maxLength={3} placeholder="INR" onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></div>
          <Button onClick={save}>Save budget</Button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded border p-2"><div className="text-xs text-gray-500">{label}</div><div className="font-semibold">{value}</div></div>;
}

function SettingsTab({ projectId, access, onSaved }: { projectId: string; access: any; onSaved: () => void }) {
  const { data: updatesRes, mutate: refreshUpdates } = useSWR(`/api/projects/${projectId}/updates`, async (url: string) => (await fetch(url)).json());
  const updates: any[] = updatesRes?.updates || [];
  const [pm, setPm] = useState<string>(access.project.assigned_user_id || 'none');
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try { await fn(); toast.success(success); onSaved(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const patchProject = (body: any, msg: string) => run('patch', () => apiSend(`/api/projects/${projectId}`, 'PATCH', body), msg);
  const action = (a: string, extra: any = {}, msg: string) => run(a, () => apiSend(`/api/projects/${projectId}/actions`, 'POST', { action: a, ...extra }), msg);
  const shareUpdate = async (id: string, v: boolean) => {
    try { await apiSend(`/api/projects/${projectId}/updates/${id}/share`, 'PATCH', { client_visible: v }); refreshUpdates(); } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-5 pt-2">
      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Client portal</h4>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={!!access.project.shared_with_client} onCheckedChange={(v) => patchProject({ shared_with_client: v }, v ? 'Project visible in client portal' : 'Project hidden from client portal')} />
          Show this project in the client portal
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy || !access.project.shared_with_client}
            onClick={() => action('request_feedback', { message: prompt('Message to the client (optional)') || undefined }, 'Feedback requested')}>
            <MessageSquareHeart className="h-4 w-4 mr-1" />Request client feedback
          </Button>
          {access.project.feedback_requested_at && <span className="text-xs text-gray-500 self-center">Requested {timeAgo(access.project.feedback_requested_at)}</span>}
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Share updates with the client</h4>
        {updates.length === 0 && <p className="text-xs text-gray-500">No updates posted yet.</p>}
        <div className="max-h-60 overflow-y-auto space-y-1">
          {updates.map((u) => (
            <div key={u.id} className="flex items-center gap-2 rounded border p-2 text-sm">
              <span className="flex-1 line-clamp-2">{u.content}</span>
              <span className="text-xs text-gray-400 whitespace-nowrap">{timeAgo(u.created_at)}</span>
              <label className="flex items-center gap-1 text-xs"><Switch checked={!!u.client_visible} onCheckedChange={(v) => shareUpdate(u.id, v)} />Client</label>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">Project Manager</h4>
        <div className="flex gap-2">
          <Select value={pm} onValueChange={setPm}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Not set</SelectItem>
              {access.team.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!!busy} onClick={() => patchProject({ assigned_user_id: pm === 'none' ? null : pm }, 'Project Manager updated')}>Save</Button>
        </div>
      </section>

      <section className="flex flex-wrap gap-2 border-t pt-4">
        <Button size="sm" variant="outline" disabled={!!busy}
          onClick={() => { const name = prompt('Template name', `${access.project.name} template`); if (name) action('save_as_template', { name }, 'Template saved'); }}>
          <LayoutTemplate className="h-4 w-4 mr-1" />Save as template
        </Button>
        {access.project.archived_at ? (
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => action('unarchive', {}, 'Project restored')}><ArchiveRestore className="h-4 w-4 mr-1" />Restore project</Button>
        ) : (
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => { if (confirm('Archive this project? It becomes read-only and hidden from lists.')) action('archive', {}, 'Project archived'); }}><Archive className="h-4 w-4 mr-1" />Archive project</Button>
        )}
      </section>
    </div>
  );
}
