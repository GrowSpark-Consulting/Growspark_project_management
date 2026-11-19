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
  const [form, setForm] = useState({ company_name: '', timezone: 'Asia/Kolkata', currency: 'INR', default_hourly_rate: 0 });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data?.data) setForm({
      company_name: data.data.company_name || '', timezone: data.data.timezone || 'UTC',
      currency: data.data.currency || 'INR', default_hourly_rate: Number(data.data.default_hourly_rate || 0),
    });
  }, [data]);
  const save = async () => {
    setSaving(true);
    try {
      await apiSend('/api/settings', 'PATCH', { ...form, default_hourly_rate: Number(form.default_hourly_rate), currency: form.currency.toUpperCase() });
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
              <div className="space-y-1"><Label>Company name</Label><Input value={form.company_name} disabled={!canEdit} onChange={(e) => setForm({ ...form, company_name: e.target.value })} maxLength={200} /></div>
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
