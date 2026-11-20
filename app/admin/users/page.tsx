'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { jsonFetcher, apiSend, errorMessage, formatDay } from '@/lib/client-api';
import { Users, UserPlus, Shield } from 'lucide-react';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function AdminUsersPage() {
  const [type, setType] = useState<'all' | 'internal' | 'client'>('all');
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(true);
  const { data, error, isLoading, mutate } = useSWR(`/api/admin/users?type=${type}`, jsonFetcher);
  const users: any[] = useMemo(() => (data?.data || []).filter((u: any) =>
    (showInactive || u.is_active !== false) &&
    (!q.trim() || `${u.name} ${u.email} ${u.account_name || ''}`.toLowerCase().includes(q.toLowerCase()))
  ), [data, q, showInactive]);

  // Suspend: temporary deactivation with a reason and an optional end date
  const [suspending, setSuspending] = useState<any | null>(null);
  const [suspendReason, setSuspendReason] = useState('');
  const [suspendUntil, setSuspendUntil] = useState('');
  const suspend = async () => {
    try {
      await apiSend(`/api/users/${suspending.id}/status`, 'POST', {
        action: 'suspend', reason: suspendReason.trim(), until: suspendUntil ? new Date(`${suspendUntil}T23:59:59`).toISOString() : null,
      });
      toast.success(`${suspending.name} suspended`);
      setSuspending(null); setSuspendReason(''); setSuspendUntil('');
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const toggle = async (u: any) => {
    const next = u.is_active === false;
    if (!confirm(next ? `Reactivate ${u.name}?` : `Deactivate ${u.name}? They will not be able to sign in.`)) return;
    try {
      await apiSend(`/api/users/${u.id}/status`, 'POST', { active: next });
      toast.success(next ? 'Account reactivated' : 'Account deactivated');
      mutate();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2"><Users className="h-7 w-7" />Users</h1>
          <p className="text-gray-600 mt-1">Employees and client users. Deactivated users cannot sign in.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline"><Link href="/admin/roles"><Shield className="h-4 w-4 mr-1" />Roles & permissions</Link></Button>
          <Button asChild><Link href="/admin/invitations"><UserPlus className="h-4 w-4 mr-1" />Invite employee</Link></Button>
          <Button asChild variant="outline"><Link href="/admin/client-portal"><UserPlus className="h-4 w-4 mr-1" />Invite client</Link></Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        {(['all', 'internal', 'client'] as const).map((t) => (
          <Button key={t} size="sm" variant={type === t ? 'default' : 'outline'} onClick={() => setType(t)}>{t === 'all' ? 'Everyone' : t === 'internal' ? 'Employees' : 'Clients'}</Button>
        ))}
        <Input className="w-64" placeholder="Search name, email, account…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Show deactivated</label>
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {error ? <p className="p-4 text-sm text-red-600">{errorMessage(error)}</p> : isLoading ? <Skeleton className="h-48 m-4" /> : (
            <table className="w-full text-sm min-w-[760px]">
              <thead><tr className="text-left text-xs text-gray-500 border-b bg-gray-50">
                <th className="p-2">Name</th><th>Email</th><th>Type</th><th>Roles / account</th><th>Status</th><th>Joined</th><th></th>
              </tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b">
                    <td className="p-2 font-medium">{u.name}{u.is_superadmin && <Badge className="ml-2 border-0 bg-purple-100 text-purple-800">Superadmin</Badge>}</td>
                    <td className="text-gray-600">{u.email}</td>
                    <td>{u.is_client ? 'Client' : 'Employee'}</td>
                    <td className="text-xs text-gray-600">{u.is_client ? u.account_name || '—' : u.roles.join(', ') || 'No role'}</td>
                    <td>{u.is_active === false
                      ? (u.suspension_reason
                        ? <span title={u.suspension_reason}><Badge variant="warning">Suspended{u.suspended_until ? ` until ${formatDay(u.suspended_until)}` : ''}</Badge></span>
                        : <Badge className="border-0 bg-red-100 text-red-800">Deactivated</Badge>)
                      : <Badge className="border-0 bg-green-100 text-green-800">Active</Badge>}</td>
                    <td className="text-xs text-gray-500">{formatDay(u.created_at)}</td>
                    <td className="pr-2 text-right">
                      {!u.is_superadmin && u.is_active !== false && <Button size="sm" variant="ghost" className="mr-1" onClick={() => setSuspending(u)}>Suspend</Button>}
                      {!u.is_superadmin && <Button size="sm" variant={u.is_active === false ? 'default' : 'outline'} onClick={() => toggle(u)}>{u.is_active === false ? 'Reactivate' : 'Deactivate'}</Button>}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-gray-500">No users found.</td></tr>}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!suspending} onOpenChange={(o) => { if (!o) setSuspending(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Suspend {suspending?.name}</DialogTitle>
            <DialogDescription>They can't sign in or use the app until the end date, or until you reactivate them.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="suspend-reason" className="text-sm font-medium">Reason</label>
              <Input id="suspend-reason" value={suspendReason} maxLength={500} onChange={(e) => setSuspendReason(e.target.value)} placeholder="For example: on leave, under review" />
            </div>
            <div className="space-y-1">
              <label htmlFor="suspend-until" className="text-sm font-medium">Until <span className="font-normal text-ink-muted">(optional)</span></label>
              <Input id="suspend-until" type="date" value={suspendUntil} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} onChange={(e) => setSuspendUntil(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setSuspending(null)}>Cancel</Button>
            <Button onClick={suspend} disabled={!suspendReason.trim()}>Suspend</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
