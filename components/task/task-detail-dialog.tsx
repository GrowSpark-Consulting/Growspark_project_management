'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { TaskStatusBadge, PriorityBadge } from '@/components/task/task-status-badge';
import { jsonFetcher, apiSend, apiUpload, errorMessage, formatBytes, formatDay, timeAgo } from '@/lib/client-api';
import { TASK_ACTIONS, statusLabel, type TaskAction } from '@/lib/task-rules';
import { projectTasks } from '@/lib/client-queries';
import {
  Play, Pause, Send, Undo2, CheckCircle2, MessageSquareWarning, RotateCcw, Paperclip, Trash2, Download,
  Reply, Pencil, Link2, X, AtSign, ListTree, History,
} from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Props {
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}

const ACTION_ICON: Record<TaskAction, React.ComponentType<{ className?: string }>> = {
  start: Play, pause: Pause, resume: Play, submit: Send, withdraw: Undo2,
  approve: CheckCircle2, request_changes: MessageSquareWarning, reopen: RotateCcw,
};

const ACTIVITY_LABEL: Record<string, string> = {
  created: 'created the task', status_changed: 'changed status', assigned: 'changed the assignee',
  priority_changed: 'changed priority', progress_updated: 'updated progress', review_submitted: 'submitted for review',
  review_approved: 'approved the task', changes_requested: 'requested changes', reopened: 'reopened the task',
};

export default function TaskDetailDialog({ taskId, open, onOpenChange, onChanged }: Props) {
  const [currentId, setCurrentId] = useState<string | null>(taskId);
  useEffect(() => { setCurrentId(taskId); }, [taskId, open]);
  const { data, error, mutate, isLoading } = useSWR(open && currentId ? `/api/tasks/${currentId}/detail` : null, jsonFetcher);
  const detail = data?.data;
  const refresh = () => { mutate(); onChanged?.(); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
        {isLoading || !detail ? (
          error ? (
            <div className="py-10 text-center text-sm text-red-600">{errorMessage(error)}</div>
          ) : (
            <div className="space-y-3 py-4">
              <DialogHeader><DialogTitle>Loading task…</DialogTitle><DialogDescription>Please wait</DialogDescription></DialogHeader>
              <Skeleton className="h-8 w-2/3" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" />
            </div>
          )
        ) : (
          <TaskBody key={detail.task.id} detail={detail} refresh={refresh} openTask={setCurrentId} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskBody({ detail, refresh, openTask }: { detail: any; refresh: () => void; openTask: (id: string) => void }) {
  const { task, project, permissions, users, team } = detail;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [trackTime, setTrackTime] = useState(true);
  const name = (id: string | null) => (id ? users[id]?.name || 'Unknown' : 'Unassigned');

  const runAction = async (action: TaskAction) => {
    if (action === 'request_changes' && !note.trim()) {
      toast.error('Write a note describing the changes needed');
      return;
    }
    setBusy(action);
    try {
      const res = await apiSend(`/api/tasks/${task.id}/status`, 'POST', {
        action,
        note: note.trim() || undefined,
        timer: ['start', 'resume', 'pause', 'submit'].includes(action) ? trackTime : undefined,
      });
      const logged = res?.data?.timer?.loggedHours;
      toast.success(`${TASK_ACTIONS[action].label} done${logged ? ` — ${logged}h logged` : ''}`);
      setNote('');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const reviewer = task.reviewer_id ? name(task.reviewer_id) : 'Project manager';

  return (
    <div className="space-y-4">
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span>{project.name}</span>
          {task.parent_task_id && (
            <button className="text-blue-600 hover:underline" onClick={() => openTask(task.parent_task_id)}>← Parent task</button>
          )}
        </div>
        <DialogTitle className="text-xl">{task.name}</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-2 pt-1">
          <TaskStatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
          <span className="text-xs text-gray-500">Assignee: <b>{name(task.assigned_to)}</b></span>
          <span className="text-xs text-gray-500">Reviewer: <b>{reviewer}</b></span>
          {task.due_date && <span className="text-xs text-gray-500">Due {formatDay(task.due_date)}</span>}
        </DialogDescription>
      </DialogHeader>

      {task.status === 'changes_requested' && task.review_note && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <b>Changes requested:</b> {task.review_note}
        </div>
      )}
      {task.status === 'review' && task.review_note && (
        <div className="rounded-md border border-purple-200 bg-purple-50 p-3 text-sm text-purple-800">
          <b>Submission note:</b> {task.review_note}
        </div>
      )}

      {permissions.actions.length > 0 && project.status !== 'complete' && (
        <div className="rounded-lg border p-3 space-y-2 bg-gray-50">
          <div className="flex flex-wrap gap-2">
            {permissions.actions.map((action: TaskAction) => {
              const Icon = ACTION_ICON[action];
              const variant = action === 'approve' ? 'default' : action === 'request_changes' ? 'destructive' : 'outline';
              return (
                <Button key={action} size="sm" variant={variant as any} disabled={!!busy} onClick={() => runAction(action)}>
                  <Icon className="h-4 w-4 mr-1" />{busy === action ? 'Saving…' : TASK_ACTIONS[action].label}
                </Button>
              );
            })}
          </div>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <Input
              placeholder={permissions.canReview && task.status === 'review' ? 'Review note (required to request changes)' : 'Optional note for the reviewer'}
              value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="bg-white"
            />
            <label className="flex items-center gap-2 text-xs text-gray-600 whitespace-nowrap">
              <Checkbox checked={trackTime} onCheckedChange={(v) => setTrackTime(v === true)} />
              Track time with Start/Pause
            </label>
          </div>
        </div>
      )}

      <Tabs defaultValue="details">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="details">Details</TabsTrigger>
          {!task.parent_task_id && <TabsTrigger value="subtasks">Subtasks ({detail.subtasks.length})</TabsTrigger>}
          <TabsTrigger value="comments">Comments ({detail.comments.length})</TabsTrigger>
          <TabsTrigger value="files">Files ({detail.files.length})</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="details"><DetailsTab detail={detail} team={team} refresh={refresh} /></TabsContent>
        {!task.parent_task_id && (
          <TabsContent value="subtasks"><SubtasksTab detail={detail} refresh={refresh} openTask={openTask} name={name} /></TabsContent>
        )}
        <TabsContent value="comments"><CommentsTab detail={detail} refresh={refresh} /></TabsContent>
        <TabsContent value="files"><FilesTab detail={detail} refresh={refresh} /></TabsContent>
        <TabsContent value="dependencies"><DependenciesTab detail={detail} refresh={refresh} openTask={openTask} /></TabsContent>
        <TabsContent value="history">
          <ul className="space-y-2 max-h-80 overflow-y-auto">
            {detail.activity.length === 0 && <li className="text-sm text-gray-500">No history yet.</li>}
            {detail.activity.map((a: any) => (
              <li key={a.id} className="text-sm border-l-2 border-gray-200 pl-3">
                <div><b>{name(a.actor_id)}</b> {ACTIVITY_LABEL[a.action] || a.action}
                  {a.action === 'status_changed' || a.action.startsWith('review') || a.action === 'changes_requested' || a.action === 'reopened'
                    ? <> ({statusLabel(a.from_value)} → {statusLabel(a.to_value)})</>
                    : a.action === 'assigned' ? <> ({name(a.from_value)} → {name(a.to_value)})</>
                    : a.action === 'progress_updated' ? <> ({a.from_value}% → {a.to_value}%)</>
                    : a.action === 'priority_changed' ? <> ({a.from_value} → {a.to_value})</> : null}
                </div>
                {a.note && <div className="text-xs text-gray-600 italic">“{a.note}”</div>}
                <div className="text-[11px] text-gray-400">{new Date(a.created_at).toLocaleString()}</div>
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DetailsTab({ detail, team, refresh }: { detail: any; team: any[]; refresh: () => void }) {
  const { task, permissions } = detail;
  const canDetails = permissions.canEditDetails && detail.project.status !== 'complete';
  const canChooseReviewer = permissions.canManage && detail.project.status !== 'complete';
  const canContribute = permissions.canContribute && detail.project.status !== 'complete';
  const [form, setForm] = useState({
    name: task.name || '', description: task.description || '', priority: task.priority,
    start_date: task.start_date?.slice(0, 10) || '', due_date: task.due_date?.slice(0, 10) || '',
    estimated_hours: task.estimated_hours ?? '', assigned_to: task.assigned_to || 'none', reviewer_id: task.reviewer_id || 'none',
    progress_percent: task.progress_percent ?? 0,
  });
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, any> = { description: form.description || null, progress_percent: Number(form.progress_percent) };
      if (canDetails) {
        Object.assign(body, {
          name: form.name, priority: form.priority,
          start_date: form.start_date || null, due_date: form.due_date || null,
          estimated_hours: form.estimated_hours === '' ? null : Number(form.estimated_hours),
          assigned_to: form.assigned_to === 'none' ? null : form.assigned_to,
        });
        if (canChooseReviewer) body.reviewer_id = form.reviewer_id === 'none' ? null : form.reviewer_id;
      } else if (!task.assigned_to && form.assigned_to !== 'none') {
        body.assigned_to = form.assigned_to; // self-assign
      }
      await apiSend(`/api/tasks/${task.id}`, 'PATCH', body);
      toast.success('Task saved');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-1">
        <Label>Title</Label>
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} disabled={!canDetails} maxLength={500} />
      </div>
      <div className="space-y-1">
        <Label>Description</Label>
        <Textarea rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} disabled={!canContribute} maxLength={5000} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label>Priority</Label>
          <Select value={form.priority} onValueChange={(v) => set('priority', v)} disabled={!canDetails}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{['low', 'medium', 'high', 'urgent'].map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1"><Label>Start</Label><Input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} disabled={!canDetails} /></div>
        <div className="space-y-1"><Label>Deadline</Label><Input type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} disabled={!canDetails} /></div>
        <div className="space-y-1"><Label>Estimate (h)</Label><Input type="number" min={0} step={0.5} value={form.estimated_hours} onChange={(e) => set('estimated_hours', e.target.value)} disabled={!canDetails} /></div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Assignee</Label>
          <Select value={form.assigned_to} onValueChange={(v) => set('assigned_to', v)} disabled={!canDetails && !!task.assigned_to}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Unassigned</SelectItem>
              {(canDetails ? team : team.filter((m: any) => m.id === detail.me)).map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}{m.id === detail.me ? ' (me)' : ''}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Reviewer</Label>
          <Select value={form.reviewer_id} onValueChange={(v) => set('reviewer_id', v)} disabled={!canChooseReviewer}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Project manager (default)</SelectItem>
              {team.filter((m: any) => m.id === form.reviewer_id || m.id !== form.assigned_to).map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {!canChooseReviewer && <p className="text-xs text-gray-500">Only a project manager can choose the reviewer.</p>}
        </div>
      </div>
      <div className="space-y-2">
        <Label>Progress: {form.progress_percent}%</Label>
        <Slider value={[Number(form.progress_percent)]} min={0} max={100} step={5} disabled={!canContribute || task.status === 'done'}
          onValueChange={(v) => set('progress_percent', v[0])} />
      </div>
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>Logged: {Number(task.actual_hours || 0).toFixed(2)}h{task.estimated_hours ? ` of ${task.estimated_hours}h` : ''}</span>
        {(canContribute || canDetails) && <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>}
      </div>
    </div>
  );
}

function SubtasksTab({ detail, refresh, openTask, name }: { detail: any; refresh: () => void; openTask: (id: string) => void; name: (id: string | null) => string }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const canAdd = detail.permissions.canContribute && detail.project.status !== 'complete';
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await apiSend('/api/tasks', 'POST', { name: title.trim(), project_id: detail.task.project_id, parent_task_id: detail.task.id, assigned_to: detail.task.assigned_to || undefined });
      setTitle('');
      toast.success('Subtask added');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const done = detail.subtasks.filter((s: any) => s.status === 'done').length;
  return (
    <div className="space-y-3 pt-2">
      {detail.subtasks.length > 0 && <p className="text-xs text-gray-500">{done} of {detail.subtasks.length} done</p>}
      <ul className="space-y-1">
        {detail.subtasks.length === 0 && <li className="text-sm text-gray-500 flex items-center gap-2"><ListTree className="h-4 w-4" />No subtasks yet.</li>}
        {detail.subtasks.map((s: any) => (
          <li key={s.id}>
            <button onClick={() => openTask(s.id)} className="w-full flex items-center gap-2 rounded border p-2 text-left hover:bg-gray-50">
              <TaskStatusBadge status={s.status} />
              <span className="flex-1 text-sm truncate">{s.name}</span>
              <span className="text-xs text-gray-500">{name(s.assigned_to)}</span>
              {s.due_date && <span className="text-xs text-gray-400">{formatDay(s.due_date)}</span>}
            </button>
          </li>
        ))}
      </ul>
      {canAdd && (
        <div className="flex gap-2">
          <Input placeholder="New subtask title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} maxLength={500} />
          <Button onClick={add} disabled={busy || !title.trim()}>Add</Button>
        </div>
      )}
    </div>
  );
}

function CommentsTab({ detail, refresh }: { detail: any; refresh: () => void }) {
  const { users, team, me } = detail;
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<any | null>(null);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canPost = detail.permissions.canContribute;
  const top = detail.comments.filter((c: any) => !c.parent_id);
  const replies = (id: string) => detail.comments.filter((c: any) => c.parent_id === id);

  const post = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await apiSend(`/api/tasks/${detail.task.id}/comments`, 'POST', { content: text.trim(), parent_id: replyTo?.id, mentions });
      setText(''); setMentions([]); setReplyTo(null);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!editing) return;
    try {
      await apiSend(`/api/comments/${editing.id}`, 'PATCH', { content: editing.content });
      setEditing(null);
      refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async (id: string) => {
    if (!confirm('Delete this comment?')) return;
    try { await apiSend(`/api/comments/${id}`, 'DELETE'); refresh(); } catch (e) { toast.error(errorMessage(e)); }
  };

  const renderComment = (c: any, isReply = false) => (
    <div key={c.id} className={isReply ? 'ml-6 border-l pl-3' : ''}>
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <b className="text-gray-800">{users[c.created_by]?.name || 'Unknown'}</b>
        <span>{timeAgo(c.created_at)}{c.updated_at && c.updated_at !== c.created_at ? ' (edited)' : ''}</span>
      </div>
      {editing?.id === c.id ? (
        <div className="space-y-1 mt-1">
          <Textarea rows={2} value={editing?.content ?? ''} onChange={(e) => setEditing({ id: c.id, content: e.target.value })} />
          <div className="flex gap-2"><Button size="sm" onClick={saveEdit}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
        </div>
      ) : (
        <p className="text-sm whitespace-pre-wrap">
          {c.content}
          {c.mentions?.length > 0 && <span className="ml-1 text-xs text-blue-600">{c.mentions.map((m: string) => `@${users[m]?.name || 'user'}`).join(' ')}</span>}
        </p>
      )}
      <div className="flex gap-3 text-xs text-gray-500 mt-0.5">
        {!isReply && canPost && <button className="hover:text-blue-600 flex items-center gap-1" onClick={() => setReplyTo(c)}><Reply className="h-3 w-3" />Reply</button>}
        {c.created_by === me && <button className="hover:text-blue-600 flex items-center gap-1" onClick={() => setEditing({ id: c.id, content: c.content })}><Pencil className="h-3 w-3" />Edit</button>}
        {(c.created_by === me || detail.permissions.canManage) && <button className="hover:text-red-600 flex items-center gap-1" onClick={() => remove(c.id)}><Trash2 className="h-3 w-3" />Delete</button>}
      </div>
    </div>
  );

  const mentionable = useMemo(() => team.filter((m: any) => m.id !== me && !mentions.includes(m.id)), [team, me, mentions]);

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-3 max-h-80 overflow-y-auto">
        {top.length === 0 && <p className="text-sm text-gray-500">No comments yet.</p>}
        {top.map((c: any) => (
          <div key={c.id} className="space-y-2">
            {renderComment(c)}
            {replies(c.id).map((r: any) => renderComment(r, true))}
          </div>
        ))}
      </div>
      {canPost && (
        <div className="space-y-2 border-t pt-3">
          {replyTo && (
            <div className="text-xs text-gray-600 flex items-center gap-2">
              Replying to <b>{users[replyTo.created_by]?.name}</b>
              <button onClick={() => setReplyTo(null)}><X className="h-3 w-3" /></button>
            </div>
          )}
          <Textarea rows={3} placeholder="Write a comment…" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
          <div className="flex flex-wrap items-center gap-2">
            <Select value="" onValueChange={(v) => setMentions((m) => [...m, v])}>
              <SelectTrigger className="w-44 h-8"><AtSign className="h-3 w-3 mr-1" /><SelectValue placeholder="Mention someone" /></SelectTrigger>
              <SelectContent>{mentionable.map((m: any) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
            </Select>
            {mentions.map((m) => (
              <span key={m} className="text-xs bg-blue-50 text-blue-700 rounded px-2 py-0.5 flex items-center gap-1">
                @{users[m]?.name}<button onClick={() => setMentions((x) => x.filter((y) => y !== m))}><X className="h-3 w-3" /></button>
              </span>
            ))}
            <Button size="sm" className="ml-auto" onClick={post} disabled={busy || !text.trim()}>{busy ? 'Posting…' : replyTo ? 'Reply' : 'Comment'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilesTab({ detail, refresh }: { detail: any; refresh: () => void }) {
  const [uploading, setUploading] = useState(false);
  const canUpload = detail.permissions.canContribute;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      await apiUpload(`/api/projects/${detail.task.project_id}/files`, file, { taskId: detail.task.id });
      toast.success('File attached');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };
  const remove = async (id: string) => {
    if (!confirm('Delete this file?')) return;
    try { await apiSend(`/api/files/${id}`, 'DELETE'); refresh(); } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div className="space-y-3 pt-2">
      <ul className="space-y-1">
        {detail.files.length === 0 && <li className="text-sm text-gray-500">No attachments.</li>}
        {detail.files.map((f: any) => (
          <li key={f.id} className="flex items-center gap-2 rounded border p-2 text-sm">
            <Paperclip className="h-4 w-4 text-gray-400" />
            <span className="flex-1 truncate">{f.file_name}</span>
            <span className="text-xs text-gray-400">{formatBytes(f.size_bytes)} · {detail.users[f.uploaded_by]?.name || ''}</span>
            <a href={`/api/files/${f.id}`} className="text-blue-600" title="Download"><Download className="h-4 w-4" /></a>
            {(f.uploaded_by === detail.me || detail.permissions.canManage) && (
              <button onClick={() => remove(f.id)} className="text-red-500" title="Delete"><Trash2 className="h-4 w-4" /></button>
            )}
          </li>
        ))}
      </ul>
      {canUpload && (
        <label className="flex items-center gap-2 text-sm cursor-pointer text-blue-600">
          <Paperclip className="h-4 w-4" />{uploading ? 'Uploading…' : 'Attach a file (max 10 MB)'}
          <input type="file" className="hidden" disabled={uploading} onChange={(e) => upload(e.target.files?.[0])} />
        </label>
      )}
    </div>
  );
}

function DependenciesTab({ detail, refresh, openTask }: { detail: any; refresh: () => void; openTask: (id: string) => void }) {
  const [options, setOptions] = useState<any[]>([]);
  const [selected, setSelected] = useState('');
  const canEdit = detail.permissions.canEditDetails;
  useEffect(() => {
    if (!canEdit) return;
    projectTasks(detail.task.project_id, detail.task.id).then(({ data }) => setOptions(data || []));
  }, [canEdit, detail.task.id, detail.task.project_id]);
  const existing = new Set(detail.dependencies.map((d: any) => d.id));
  const add = async () => {
    if (!selected) return;
    try {
      await apiSend(`/api/tasks/${detail.task.id}/dependencies`, 'POST', { depends_on_task_id: selected });
      setSelected('');
      refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async (id: string) => {
    try { await apiSend(`/api/tasks/${detail.task.id}/dependencies?dependsOn=${id}`, 'DELETE'); refresh(); } catch (e) { toast.error(errorMessage(e)); }
  };
  const blocking = detail.dependencies.filter((d: any) => d.status !== 'done');
  return (
    <div className="space-y-3 pt-2">
      {blocking.length > 0 && detail.task.status !== 'done' && (
        <p className="text-xs rounded bg-amber-50 text-amber-800 p-2">This task is waiting on {blocking.length} unfinished task(s).</p>
      )}
      <div>
        <h4 className="text-sm font-medium mb-1">Blocked by</h4>
        {detail.dependencies.length === 0 && <p className="text-sm text-gray-500">No dependencies.</p>}
        {detail.dependencies.map((d: any) => (
          <div key={d.id} className="flex items-center gap-2 rounded border p-2 mb-1">
            <Link2 className="h-4 w-4 text-gray-400" />
            <button className="flex-1 text-left text-sm hover:underline" onClick={() => openTask(d.id)}>{d.name}</button>
            <TaskStatusBadge status={d.status} />
            {canEdit && <button onClick={() => remove(d.id)} className="text-red-500"><X className="h-4 w-4" /></button>}
          </div>
        ))}
      </div>
      {detail.dependents.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-1">Blocks</h4>
          {detail.dependents.map((d: any) => (
            <button key={d.id} className="block text-sm text-blue-600 hover:underline" onClick={() => openTask(d.id)}>{d.name}</button>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="flex gap-2">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger><SelectValue placeholder="Add a task this one depends on" /></SelectTrigger>
            <SelectContent>{options.filter((o) => !existing.has(o.id)).map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={add} disabled={!selected}>Add</Button>
        </div>
      )}
      <p className="text-[11px] text-gray-400 flex items-center gap-1"><History className="h-3 w-3" />Finish-to-start: this task should start after the tasks above are done.</p>
    </div>
  );
}
