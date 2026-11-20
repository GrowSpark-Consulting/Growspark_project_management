/**
 * Sign-up approval client. Everything goes through the API (server side checks, no browser
 * access to the tables). See lib/user-approval-server.ts for what "pending" and "approved" mean.
 */
import { logger } from './debug-logger';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  image: string | null;
  bio: string | null;
  skills: string[] | null;
  workload_sentiment: string | null;
  is_approved: boolean;
  approval_requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PendingUser extends UserProfile {
  current_roles: Array<{
    role_name: string;
    department_name: string;
  }>;
}

export interface ApprovalAction {
  userId: string;
  action: 'approve' | 'reject';
  approvedBy: string;
  reason?: string;
}

async function call(path: string, init?: RequestInit) {
  const res = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

class UserApprovalService {
  /** People who signed up and are waiting for a role. */
  async getPendingUsers(): Promise<PendingUser[]> {
    const r = await call('/api/users/pending');
    if (!r.ok) throw new Error(r.body?.error || 'Failed to load pending users');
    return r.body.users || [];
  }

  /** Approve = assign a role (Employee unless roleId is given). */
  async approveUser(userId: string, _approvedBy: string, reason?: string, roleId?: string): Promise<boolean> {
    const r = await call('/api/users/approve', { method: 'POST', body: JSON.stringify({ userId, action: 'approve', reason, roleId }) });
    if (!r.ok) logger.error('Approve user failed', { userId, error: r.body?.error });
    return r.ok;
  }

  /** Reject = deactivate the account. */
  async rejectUser(userId: string, _rejectedBy: string, reason?: string): Promise<boolean> {
    const r = await call('/api/users/approve', { method: 'POST', body: JSON.stringify({ userId, action: 'reject', reason }) });
    if (!r.ok) logger.error('Reject user failed', { userId, error: r.body?.error });
    return r.ok;
  }

  /** Tell the administrators this account is waiting. */
  async requestApproval(_userId: string): Promise<boolean> {
    return (await call('/api/users/approval-status', { method: 'POST', body: '{}' })).ok;
  }

  /** Does the signed-in user have a real role (or is a client / superadmin)? */
  async isUserApproved(_userId: string): Promise<boolean> {
    const r = await call('/api/users/approval-status');
    return r.ok && !!r.body?.approved;
  }

  async getApprovalStats(): Promise<{ total_pending: number; total_approved: number; total_rejected: number; pending_by_date: Record<string, number> }> {
    const r = await call('/api/users/approve');
    if (!r.ok) throw new Error(r.body?.error || 'Failed to load approval stats');
    return r.body.stats;
  }

  async bulkApproveUsers(userIds: string[], approvedBy: string, reason?: string): Promise<{ successful: string[]; failed: string[] }> {
    const successful: string[] = [];
    const failed: string[] = [];
    for (const id of userIds) {
      ((await this.approveUser(id, approvedBy, reason)) ? successful : failed).push(id);
    }
    return { successful, failed };
  }
}

export const userApprovalService = new UserApprovalService();
