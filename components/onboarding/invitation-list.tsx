'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw, XCircle, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PaginationBar } from '@/components/ui/pagination-bar';
import { useListParams } from '@/lib/hooks/use-list-params';
import type { PageInfo } from '@/lib/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface Invitation {
  id: string;
  email: string;
  name: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  created_at: string;
  expires_at: string;
  roles: { id: string; name: string } | null;
  departments: { id: string; name: string } | null;
  inviter: { id: string; name: string; email: string } | null;
}

const statusBadgeVariants: Record<string, { className: string; label: string }> = {
  pending: { className: 'bg-yellow-100 text-yellow-800 border-yellow-200', label: 'Pending' },
  accepted: { className: 'bg-green-100 text-green-800 border-green-200', label: 'Accepted' },
  expired: { className: 'bg-red-100 text-red-800 border-red-200', label: 'Expired' },
  revoked: { className: 'bg-gray-100 text-gray-600 border-gray-200', label: 'Revoked' },
};

export function InvitationList() {
  // Page, size, status and search live in the URL; the server filters and pages
  const list = useListParams('invitations', { status: '', q: '' });
  const [searchInput, setSearchInput] = useState(list.values.q);
  useEffect(() => { setSearchInput(list.values.q); }, [list.values.q]);
  useEffect(() => {
    if (searchInput === list.values.q) return;
    const timer = setTimeout(() => list.update({ q: searchInput.trim() }), 350);
    return () => clearTimeout(timer);
  }, [searchInput, list]);
  const [pagination, setPagination] = useState<PageInfo | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [resending, setResending] = useState<string | null>(null);

  const fetchInvitations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/invitations?${list.apiQuery}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setInvitations(data.invitations || []);
        setPagination(data.pagination || null);
      } else {
        toast.error('Failed to load invitations');
      }
    } catch {
      toast.error('Network error loading invitations');
    } finally {
      setLoading(false);
    }
  }, [list.apiQuery]);

  useEffect(() => {
    fetchInvitations();
  }, [fetchInvitations]);

  async function handleRevoke(id: string, isPending: boolean) {
    setRevoking(id);
    try {
      const res = await fetch(`/api/invitations/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (res.ok) {
        if (isPending) {
          toast.success('Invitation revoked');
          setInvitations((prev) =>
            prev.map((inv) => (inv.id === id ? { ...inv, status: 'revoked' as const } : inv))
          );
        } else {
          toast.success('Invitation deleted');
          setInvitations((prev) => prev.filter((inv) => inv.id !== id));
          fetchInvitations();
        }
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to process invitation');
      }
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setRevoking(null);
    }
  }

  async function handleResend(id: string) {
    setResending(id);
    try {
      const res = await fetch(`/api/invitations/${id}/resend`, {
        method: 'POST',
        credentials: 'include',
      });

      if (res.ok) {
        toast.success('Invitation email resent');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to resend invitation');
      }
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setResending(null);
    }
  }

  function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  if (loading && invitations.length === 0 && !pagination) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        <span className="ml-2 text-sm text-gray-500">Loading invitations...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Invitations</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            fetchInvitations();
          }}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search name or email"
          aria-label="Search invitations"
          className="w-64"
        />
        {(['', 'pending', 'accepted', 'expired', 'revoked'] as const).map((st) => (
          <Button key={st || 'all'} size="sm" variant={list.values.status === st ? 'default' : 'outline'} onClick={() => list.update({ status: st })}>
            {st ? statusBadgeVariants[st].label : 'All'}
          </Button>
        ))}
      </div>

      {invitations.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-gray-500">
            {list.values.status || list.values.q ? 'No invitations match these filters.' : 'No invitations yet. Invite your first team member above.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((inv) => {
                const statusBadge = statusBadgeVariants[inv.status] || statusBadgeVariants.pending;
                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.name}</TableCell>
                    <TableCell className="text-gray-600">{inv.email}</TableCell>
                    <TableCell>{inv.roles?.name || 'Unknown'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={statusBadge.className}>
                        {statusBadge.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-gray-500 text-sm">
                      {formatDate(inv.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {inv.status === 'pending' && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                              onClick={() => handleResend(inv.id)}
                              disabled={resending === inv.id}
                            >
                              {resending === inv.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <>
                                  <Send className="mr-1 h-4 w-4" />
                                  Resend
                                </>
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              onClick={() => handleRevoke(inv.id, true)}
                              disabled={revoking === inv.id}
                            >
                              {revoking === inv.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <>
                                  <XCircle className="mr-1 h-4 w-4" />
                                  Revoke
                                </>
                              )}
                            </Button>
                          </>
                        )}
                        {inv.status !== 'pending' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleRevoke(inv.id, false)}
                            disabled={revoking === inv.id}
                          >
                            {revoking === inv.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <>
                                <XCircle className="mr-1 h-4 w-4" />
                                Delete
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <PaginationBar
        pagination={pagination}
        onPageChange={list.setPage}
        onPageSizeChange={list.setPageSize}
        loading={loading}
        itemLabel="invitations"
      />
    </div>
  );
}
