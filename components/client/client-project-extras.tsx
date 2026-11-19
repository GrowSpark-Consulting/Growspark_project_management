'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { jsonFetcher, apiSend, apiUpload, errorMessage, formatBytes, formatDay, timeAgo } from '@/lib/client-api';
import { CheckCircle2, Circle, CircleDot, Download, ExternalLink, Upload, Reply, Flag, PackageCheck, FileText, MessagesSquare, Bug, Star } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const DELIVERABLE_LABEL: Record<string, { label: string; cls: string }> = {
  client_review: { label: 'Awaiting your review', cls: 'bg-blue-100 text-blue-800' },
  approved: { label: 'Approved', cls: 'bg-green-100 text-green-800' },
  rejected: { label: 'Changes requested', cls: 'bg-red-100 text-red-800' },
};

export default function ClientProjectExtras({ projectId }: { projectId: string }) {
  return (
    <Tabs defaultValue="timeline">
      <TabsList className="flex flex-wrap h-auto">
        <TabsTrigger value="timeline"><Flag className="h-3.5 w-3.5 mr-1" />Timeline</TabsTrigger>
        <TabsTrigger value="deliverables"><PackageCheck className="h-3.5 w-3.5 mr-1" />Deliverables</TabsTrigger>
        <TabsTrigger value="documents"><FileText className="h-3.5 w-3.5 mr-1" />Documents</TabsTrigger>
        <TabsTrigger value="discussion"><MessagesSquare className="h-3.5 w-3.5 mr-1" />Discussion</TabsTrigger>
        <TabsTrigger value="issues"><Bug className="h-3.5 w-3.5 mr-1" />Issues</TabsTrigger>
        <TabsTrigger value="feedback"><Star className="h-3.5 w-3.5 mr-1" />Feedback history</TabsTrigger>
      </TabsList>
      <TabsContent value="timeline"><Timeline projectId={projectId} /></TabsContent>
      <TabsContent value="deliverables"><ClientDeliverables projectId={projectId} /></TabsContent>
      <TabsContent value="documents"><Documents projectId={projectId} /></TabsContent>
      <TabsContent value="discussion"><Discussion projectId={projectId} /></TabsContent>
      <TabsContent value="issues"><Issues projectId={projectId} /></TabsContent>
      <TabsContent value="feedback"><FeedbackHistory projectId={projectId} /></TabsContent>
    </Tabs>
  );
}

function Timeline({ projectId }: { projectId: string }) {
  const { data, isLoading } = useSWR(`/api/client/portal/projects/${projectId}/timeline`, jsonFetcher);
  const t = data?.data;
  if (isLoading || !t) return <Skeleton className="h-40" />;
  return (
    <Card><CardContent className="p-4 space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div><div className="text-xs text-muted-foreground">Start</div><div className="font-medium">{formatDay(t.project.start_date)}</div></div>
        <div><div className="text-xs text-muted-foreground">Planned end</div><div className="font-medium">{formatDay(t.project.end_date)}</div></div>
        <div>
          <div className="text-xs text-muted-foreground">Completion</div>
          <div className="flex items-center gap-2"><div className="h-2 flex-1 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${t.progress_percent}%` }} /></div><b>{t.progress_percent}%</b></div>
        </div>
      </div>
      {t.stages.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2">Project stages</h4>
          <ol className="flex flex-wrap gap-2">
            {t.stages.map((s: any, i: number) => (
              <li key={i} className={`flex items-center gap-1 rounded-full border px-3 py-1 text-xs ${s.state === 'current' ? 'border-primary text-primary font-medium' : s.state === 'completed' ? 'text-green-700 border-green-200 bg-green-50' : 'text-muted-foreground'}`}>
                {s.state === 'completed' ? <CheckCircle2 className="h-3 w-3" /> : s.state === 'current' ? <CircleDot className="h-3 w-3" /> : <Circle className="h-3 w-3" />}{s.label}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div>
        <h4 className="text-sm font-semibold mb-2">Milestones</h4>
        {t.milestones.length === 0 ? <p className="text-sm text-muted-foreground">No milestones shared yet.</p> : (
          <ul className="space-y-1">
            {t.milestones.map((m: any) => (
              <li key={m.id} className="flex items-center gap-2 text-sm">
                {m.status === 'completed' ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
                <span className={`flex-1 ${m.status === 'completed' ? 'line-through text-muted-foreground' : ''}`}>{m.name}</span>
                <span className="text-xs text-muted-foreground">{formatDay(m.date)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {t.upcomingDeliveries.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-1">Upcoming deliveries</h4>
          {t.upcomingDeliveries.map((m: any) => <div key={m.id} className="text-sm">{formatDay(m.date)} — {m.name}</div>)}
        </div>
      )}
    </CardContent></Card>
  );
}

export function ClientDeliverables({ projectId, compact }: { projectId?: string; compact?: boolean }) {
  const { data, mutate, isLoading } = useSWR(`/api/client/portal/deliverables${projectId ? `?projectId=${projectId}` : ''}`, jsonFetcher);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const items: any[] = data?.data || [];
  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && !feedback[id]?.trim()) { toast.error('Please tell the team what needs to change'); return; }
    setBusy(id);
    try {
      await apiSend(`/api/client/portal/deliverables/${id}/decision`, 'POST', { decision, feedback: feedback[id] || null });
      toast.success(decision === 'approved' ? 'Deliverable approved' : 'Feedback sent to the team');
      mutate();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  if (isLoading) return <Skeleton className="h-32" />;
  if (items.length === 0) return <Card><CardContent className="p-6 text-sm text-muted-foreground text-center">No deliverables shared yet.</CardContent></Card>;
  return (
    <div className="space-y-3">
      {items.map((d) => {
        const st = DELIVERABLE_LABEL[d.status] || DELIVERABLE_LABEL.client_review;
        return (
          <Card key={d.id}><CardContent className="p-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium flex-1">{d.name} <span className="text-xs text-muted-foreground">v{d.version || 1}</span></span>
              {!projectId && d.project_name && <span className="text-xs text-muted-foreground">{d.project_name}</span>}
              <Badge className={`border-0 ${st.cls}`}>{st.label}</Badge>
            </div>
            {d.description && <p className="text-sm text-muted-foreground">{d.description}</p>}
            <div className="flex flex-wrap gap-3 text-sm">
              {d.file && <a href={`/api/client/portal/files/${d.file.id}`} className="text-primary flex items-center gap-1"><Download className="h-4 w-4" />{d.file.file_name}</a>}
              {d.link && <a href={d.link} target="_blank" rel="noreferrer" className="text-primary flex items-center gap-1"><ExternalLink className="h-4 w-4" />Open link</a>}
              {d.shared_at && <span className="text-xs text-muted-foreground">Shared {formatDay(d.shared_at)}</span>}
              {d.approved_at && <span className="text-xs text-muted-foreground">Decided {formatDay(d.approved_at)}</span>}
            </div>
            {d.feedback && d.status !== 'client_review' && <p className="text-sm italic">Your comment: “{d.feedback}”</p>}
            {d.status === 'client_review' && !compact && (
              <div className="space-y-2 pt-1">
                <Textarea rows={2} placeholder="Comments (required if requesting changes)" value={feedback[d.id] || ''} onChange={(e) => setFeedback({ ...feedback, [d.id]: e.target.value })} />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy === d.id} onClick={() => decide(d.id, 'approved')}><CheckCircle2 className="h-4 w-4 mr-1" />Approve</Button>
                  <Button size="sm" variant="outline" disabled={busy === d.id} onClick={() => decide(d.id, 'rejected')}>Request changes</Button>
                </div>
              </div>
            )}
          </CardContent></Card>
        );
      })}
    </div>
  );
}

function Documents({ projectId }: { projectId: string }) {
  const { data, mutate, isLoading } = useSWR(`/api/client/portal/projects/${projectId}/files`, jsonFetcher);
  const [uploading, setUploading] = useState(false);
  const files: any[] = data?.data || [];
  const upload = async (f?: File) => {
    if (!f) return;
    setUploading(true);
    try { await apiUpload(`/api/client/portal/projects/${projectId}/files`, f); toast.success('Document uploaded'); mutate(); } catch (e) { toast.error(errorMessage(e)); } finally { setUploading(false); }
  };
  return (
    <Card><CardContent className="p-4 space-y-3">
      {isLoading ? <Skeleton className="h-20" /> : files.length === 0 ? <p className="text-sm text-muted-foreground">No documents shared yet.</p> : (
        <ul className="divide-y">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-2 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 truncate">{f.file_name}{f.uploaded_by_me && <span className="ml-1 text-xs text-muted-foreground">(uploaded by you)</span>}</span>
              <span className="text-xs text-muted-foreground">{formatBytes(f.size_bytes)} · {formatDay(f.created_at)}</span>
              <a href={`/api/client/portal/files/${f.id}`} className="text-primary"><Download className="h-4 w-4" /></a>
            </li>
          ))}
        </ul>
      )}
      <label className="inline-flex items-center gap-2 text-sm cursor-pointer text-primary">
        <Upload className="h-4 w-4" />{uploading ? 'Uploading…' : 'Upload a requested document (max 10 MB)'}
        <input type="file" className="hidden" disabled={uploading} onChange={(e) => upload(e.target.files?.[0])} />
      </label>
    </CardContent></Card>
  );
}

function Discussion({ projectId }: { projectId: string }) {
  const { data, mutate, isLoading } = useSWR(`/api/client/portal/projects/${projectId}/discussion`, jsonFetcher);
  const [message, setMessage] = useState('');
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [replyTo, setReplyTo] = useState<Record<string, string | null>>({});
  const items: any[] = data?.data || [];
  const post = async () => {
    try { await apiSend(`/api/client/portal/projects/${projectId}/discussion`, 'POST', { content: message }); setMessage(''); mutate(); toast.success('Message sent to the team'); } catch (e) { toast.error(errorMessage(e)); }
  };
  const comment = async (updateId: string) => {
    const content = replyText[updateId];
    if (!content?.trim()) return;
    try {
      await apiSend(`/api/client/portal/updates/${updateId}/comments`, 'POST', { content, parent_id: replyTo[updateId] || null });
      setReplyText({ ...replyText, [updateId]: '' }); setReplyTo({ ...replyTo, [updateId]: null });
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div className="space-y-3">
      <Card><CardContent className="p-4 space-y-2">
        <Textarea rows={3} placeholder="Write a message to the project team…" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} />
        <Button size="sm" onClick={post} disabled={!message.trim()}>Send message</Button>
      </CardContent></Card>
      {isLoading ? <Skeleton className="h-32" /> : items.length === 0 ? <p className="text-sm text-muted-foreground">No shared updates yet.</p> : items.map((u) => {
        const top = u.comments.filter((c: any) => !c.parent_id);
        return (
          <Card key={u.id}><CardContent className="p-4 space-y-2">
            <div className="text-xs text-muted-foreground"><b className="text-foreground">{u.author.name}</b>{u.author.is_client ? ' (client)' : ''} · {timeAgo(u.created_at)}</div>
            <p className="text-sm whitespace-pre-wrap">{u.content}</p>
            <div className="space-y-2 border-l pl-3">
              {top.map((c: any) => (
                <div key={c.id} className="space-y-1">
                  <CommentLine c={c} onReply={() => setReplyTo({ ...replyTo, [u.id]: c.id })} />
                  {u.comments.filter((r: any) => r.parent_id === c.id).map((r: any) => <div key={r.id} className="ml-5"><CommentLine c={r} /></div>)}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Input placeholder={replyTo[u.id] ? 'Write a reply…' : 'Comment on this update…'} value={replyText[u.id] || ''} onChange={(e) => setReplyText({ ...replyText, [u.id]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && comment(u.id)} />
              <Button size="sm" variant="outline" onClick={() => comment(u.id)}>{replyTo[u.id] ? 'Reply' : 'Comment'}</Button>
              {replyTo[u.id] && <Button size="sm" variant="ghost" onClick={() => setReplyTo({ ...replyTo, [u.id]: null })}>Cancel</Button>}
            </div>
          </CardContent></Card>
        );
      })}
    </div>
  );
}

function CommentLine({ c, onReply }: { c: any; onReply?: () => void }) {
  return (
    <div className="text-sm">
      <b>{c.author.name}</b>{c.author.is_client ? <span className="text-xs text-muted-foreground"> (client)</span> : <span className="text-xs text-muted-foreground"> (team)</span>}
      <span className="text-xs text-muted-foreground"> · {timeAgo(c.created_at)}</span>
      <p className="whitespace-pre-wrap">{c.content}</p>
      {onReply && <button className="text-xs text-primary flex items-center gap-1" onClick={onReply}><Reply className="h-3 w-3" />Reply</button>}
    </div>
  );
}

function Issues({ projectId }: { projectId: string }) {
  const { data, mutate, isLoading } = useSWR(`/api/client/portal/projects/${projectId}/issues`, jsonFetcher);
  const [form, setForm] = useState({ title: '', content: '', severity: 'medium' });
  const issues: any[] = data?.data || [];
  const report = async () => {
    try { await apiSend(`/api/client/portal/projects/${projectId}/issues`, 'POST', form); setForm({ title: '', content: '', severity: 'medium' }); mutate(); toast.success('Issue reported to the team'); } catch (e) { toast.error(errorMessage(e)); }
  };
  const statusCls = (s: string) => s === 'resolved' ? 'bg-green-100 text-green-800' : s === 'in_progress' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800';
  return (
    <div className="space-y-3">
      <Card><CardContent className="p-4 space-y-2">
        <h4 className="text-sm font-semibold">Report an issue</h4>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2">
          <Input placeholder="Short title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} />
          <Select value={form.severity} onValueChange={(v) => setForm({ ...form, severity: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{['low', 'medium', 'high', 'critical'].map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Textarea rows={3} placeholder="Describe the problem…" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} maxLength={5000} />
        <Button size="sm" onClick={report} disabled={!form.title.trim() || !form.content.trim()}>Submit issue</Button>
      </CardContent></Card>
      {isLoading ? <Skeleton className="h-20" /> : issues.length === 0 ? <p className="text-sm text-muted-foreground">No issues reported.</p> : issues.map((i) => (
        <Card key={i.id}><CardContent className="p-3 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium flex-1">{i.title || i.content.slice(0, 80)}</span>
            <Badge className={`border-0 capitalize ${statusCls(i.status)}`}>{i.status === 'in_progress' ? 'In progress' : i.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{i.content}</p>
          <div className="text-xs text-muted-foreground">Reported {formatDay(i.created_at)}{i.resolved_at ? ` · resolved ${formatDay(i.resolved_at)}` : ''}</div>
          {i.resolution_note && <p className="text-sm">Resolution: {i.resolution_note}</p>}
        </CardContent></Card>
      ))}
    </div>
  );
}

function FeedbackHistory({ projectId }: { projectId: string }) {
  const { data, isLoading } = useSWR('/api/client/portal/feedback', jsonFetcher);
  const items: any[] = (data?.data || []).filter((f: any) => f.project_id === projectId);
  if (isLoading) return <Skeleton className="h-20" />;
  return items.length === 0 ? <p className="text-sm text-muted-foreground">You have not submitted feedback for this project yet.</p> : (
    <div className="space-y-2">
      {items.map((f) => (
        <Card key={f.id}><CardContent className="p-3 text-sm space-y-1">
          <div className="flex items-center gap-2"><Star className="h-4 w-4 text-amber-500" /><b>{f.satisfaction_score ?? '—'}/10</b><span className="text-xs text-muted-foreground">{formatDay(f.submitted_at)}</span></div>
          {f.what_went_well && <p><span className="text-muted-foreground">Went well:</span> {f.what_went_well}</p>}
          {f.what_needs_improvement && <p><span className="text-muted-foreground">Improve:</span> {f.what_needs_improvement}</p>}
        </CardContent></Card>
      ))}
    </div>
  );
}
