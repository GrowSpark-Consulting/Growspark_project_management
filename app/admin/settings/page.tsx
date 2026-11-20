'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/hooks/useAuth';
import { isSuperadminProfile } from '@/lib/portal';
import { jsonFetcher, apiSend, errorMessage } from '@/lib/client-api';
import { Building } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function CompanySettingsPage() {
  const { userProfile } = useAuth();
  const canEdit = isSuperadminProfile(userProfile as any);
  const { data, isLoading, mutate } = useSWR('/api/settings', jsonFetcher);
  const [form, setForm] = useState({ company_name: '', workspace_name: '', workspace_slug: '', company_phone: '', timezone: 'Asia/Kolkata', currency: 'INR', default_hourly_rate: 0 });
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const uploadLogo = async (file?: File | null) => {
    if (!file) return;
    setLogoBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/settings/logo", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Upload failed");
      toast.success("Logo updated");
      mutate();
    } catch (e) { toast.error(errorMessage(e)); } finally { setLogoBusy(false); }
  };
  const removeLogo = async () => {
    setLogoBusy(true);
    try { await apiSend("/api/settings/logo", "DELETE"); toast.success("Logo removed"); mutate(); } catch (e) { toast.error(errorMessage(e)); } finally { setLogoBusy(false); }
  };
  useEffect(() => {
    if (data?.data) setForm({
      company_name: data.data.company_name || '', workspace_name: data.data.workspace_name || '', workspace_slug: data.data.workspace_slug || '', company_phone: data.data.company_phone || '', timezone: data.data.timezone || 'UTC',
      currency: data.data.currency || 'INR', default_hourly_rate: Number(data.data.default_hourly_rate || 0),
    });
  }, [data]);
  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { ...form, default_hourly_rate: Number(form.default_hourly_rate), currency: form.currency.toUpperCase() };
      if (!form.workspace_name.trim()) delete payload.workspace_name;
      if (!form.workspace_slug.trim()) delete payload.workspace_slug;
      await apiSend('/api/settings', 'PATCH', payload);
      toast.success('Company settings saved');
      mutate();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><Building className="h-7 w-7" />Company Settings</h1>
        <p className="text-gray-600 mt-1">Your company account. One company per installation.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Company account</CardTitle><CardDescription>{canEdit ? 'Only superadmins can change these settings.' : 'Read-only: ask a superadmin to change these settings.'}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? <Skeleton className="h-40" /> : (
            <>
              <div className="space-y-2">
                <Label>Company logo</Label>
                <div className="flex items-center gap-3">
                  <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-md border border-line bg-surface-sunken">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {data?.data?.logo_path ? <img src={`/api/settings/logo?v=${encodeURIComponent(data.data.updated_at || "")}`} alt="Company logo" className="h-full w-full object-contain" /> : <Building className="h-6 w-6 text-ink-muted" />}
                  </div>
                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-line-strong bg-surface px-3 text-sm font-medium hover:bg-surface-hover">
                        {logoBusy ? "Working…" : data?.data?.logo_path ? "Replace logo" : "Upload logo"}
                        <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={logoBusy} onChange={(e) => { uploadLogo(e.target.files?.[0]); e.target.value = ""; }} />
                      </label>
                      {data?.data?.logo_path && <Button variant="outline" size="sm" onClick={removeLogo} disabled={logoBusy}>Remove</Button>}
                      <span className="text-xs text-ink-muted">PNG, JPG or WebP, up to 1 MB</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-1"><Label>Company name</Label><Input value={form.company_name} disabled={!canEdit} onChange={(e) => setForm({ ...form, company_name: e.target.value })} maxLength={200} /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1"><Label>Workspace name</Label><Input value={form.workspace_name} disabled={!canEdit} onChange={(e) => setForm({ ...form, workspace_name: e.target.value })} maxLength={80} placeholder="Shown on the login and workspace pages" /></div>
                <div className="space-y-1"><Label>Workspace URL</Label><Input value={form.workspace_slug} disabled={!canEdit} onChange={(e) => setForm({ ...form, workspace_slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} maxLength={40} placeholder="growspark" />
                  {form.workspace_slug && <p className="text-xs text-ink-muted">{typeof window !== 'undefined' ? window.location.origin : ''}/{form.workspace_slug}</p>}</div>
              </div>
              <div className="space-y-1"><Label>Company phone</Label><Input type="tel" value={form.company_phone} disabled={!canEdit} onChange={(e) => setForm({ ...form, company_phone: e.target.value })} placeholder="+91 98765 43210" maxLength={20} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label>Timezone</Label><Input value={form.timezone} disabled={!canEdit} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="e.g. Asia/Kolkata" /></div>
                <div className="space-y-1"><Label>Default currency (ISO code, e.g. INR)</Label><Input value={form.currency} disabled={!canEdit} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} maxLength={3} /></div>
              </div>
              <div className="space-y-1">
                <Label>Default hourly rate (used for project budget monitoring)</Label>
                <Input type="number" min={0} value={form.default_hourly_rate} disabled={!canEdit} onChange={(e) => setForm({ ...form, default_hourly_rate: Number(e.target.value) })} />
              </div>
              {canEdit && <Button onClick={save} disabled={saving || !form.company_name.trim()}>{saving ? 'Saving…' : 'Save settings'}</Button>}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
