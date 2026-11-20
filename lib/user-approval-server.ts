/**
 * Sign-up approval, on the real schema (server side only).
 *
 * A "pending" user is an internal, active account that signed up but holds no real role yet: the
 * same condition that keeps them on /welcome (see hasAssignedRole in lib/portal.ts). Approving
 * assigns a role (Employee by default); rejecting deactivates the account (Supabase sign-in ban +
 * is_active = false), the same mechanism as Admin › Users.
 */
import { notify } from '@/lib/notify';
import { roleGrantRefusal } from '@/lib/role-guard';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

const UNASSIGNED = (r: { name?: string | null; is_system_role?: boolean | null } | null) => {
  const n = (r?.name || '').toLowerCase();
  return !!r?.is_system_role && (n.includes('unassigned') || n === 'no assigned role');
};

async function roleMap(admin: Db) {
  const { data } = await admin.from('user_roles').select('user_id, roles!user_roles_role_id_fkey(id, name, is_system_role)');
  const map = new Map<string, Array<{ id: string; name: string; is_system_role: boolean }>>();
  for (const row of data || []) {
    const role = Array.isArray(row.roles) ? row.roles[0] : row.roles;
    if (!role) continue;
    map.set(row.user_id, [...(map.get(row.user_id) || []), role]);
  }
  return map;
}

/** Internal, non-superadmin profiles with no real role. `active` = still allowed to sign in. */
async function internalWithoutRole(admin: Db, active: boolean) {
  const [{ data: profiles }, roles] = await Promise.all([
    admin.from('user_profiles')
      .select('id, name, email, image, bio, skills, workload_sentiment, is_active, deactivated_at, created_at, updated_at')
      .eq('is_client', false).eq('is_superadmin', false).order('created_at', { ascending: false }),
    roleMap(admin),
  ]);
  return (profiles || []).filter((p: any) => {
    const held = roles.get(p.id) || [];
    const noRealRole = held.length === 0 || held.every((r) => UNASSIGNED(r));
    return noRealRole && (active ? p.is_active !== false : p.is_active === false && !!p.deactivated_at);
  }).map((p: any) => ({ ...p, held: roles.get(p.id) || [] }));
}

export async function listPendingUsers(admin: Db) {
  const rows = await internalWithoutRole(admin, true);
  return rows.map((p: any) => ({
    id: p.id, name: p.name, email: p.email, image: p.image, bio: p.bio, skills: p.skills,
    workload_sentiment: p.workload_sentiment,
    is_approved: false, approval_requested_at: p.created_at, approved_by: null, approved_at: null,
    created_at: p.created_at, updated_at: p.updated_at,
    current_roles: p.held.map((r: any) => ({ role_name: r.name, department_name: '' })),
  }));
}

export async function approvalStats(admin: Db) {
  const [pending, rejected, roles, { data: profiles }] = await Promise.all([
    internalWithoutRole(admin, true), internalWithoutRole(admin, false), roleMap(admin),
    admin.from('user_profiles').select('id, is_active').eq('is_client', false).eq('is_superadmin', false),
  ]);
  const approved = (profiles || []).filter((p: any) => p.is_active !== false && (roles.get(p.id) || []).some((r) => !UNASSIGNED(r))).length;
  const pending_by_date: Record<string, number> = {};
  for (const p of pending) { const d = String(p.created_at).slice(0, 10); pending_by_date[d] = (pending_by_date[d] || 0) + 1; }
  return { total_pending: pending.length, total_approved: approved, total_rejected: rejected.length, pending_by_date };
}

/** True when the user can use the app: a client, a superadmin, or someone holding a real role. */
export async function isApproved(admin: Db, userId: string) {
  const { data: p } = await admin.from('user_profiles').select('is_client, is_superadmin, is_active').eq('id', userId).maybeSingle();
  if (!p || p.is_active === false) return false;
  if (p.is_client || p.is_superadmin) return true;
  return (await roleMap(admin)).get(userId)?.some((r) => !UNASSIGNED(r)) || false;
}

export async function approveUser(admin: Db, userId: string, approverId: string, roleId?: string | null): Promise<{ ok: boolean; error?: string }> {
  const { data: target } = await admin.from('user_profiles').select('id, name, is_client, is_superadmin, is_active').eq('id', userId).maybeSingle();
  if (!target || target.is_client || target.is_superadmin) return { ok: false, error: 'User not found' };
  if (target.is_active === false) return { ok: false, error: 'This account was rejected. Reactivate it in Admin › Users first.' };

  let role: { id: string; name: string } | null = null;
  if (roleId) {
    const { data } = await admin.from('roles').select('id, name, is_system_role').eq('id', roleId).maybeSingle();
    if (!data || data.is_system_role) return { ok: false, error: 'Choose an ordinary role (not Superadmin or Client)' };
    role = data;
  } else {
    const { data } = await admin.from('roles').select('id, name').ilike('name', 'employee').eq('is_system_role', false).limit(1).maybeSingle();
    role = data;
  }
  if (!role) return { ok: false, error: 'The Employee role does not exist. Create it in Admin › Roles or pick a role.' };
  const { data: fullRole } = await admin.from('roles').select('id, name, is_system_role, permissions').eq('id', role.id).single();
  const refusal = await roleGrantRefusal(admin, approverId, fullRole);
  if (refusal) return { ok: false, error: refusal };

  // Replace the placeholder "No Assigned Role" with the real one
  const held = (await roleMap(admin)).get(userId) || [];
  const placeholders = held.filter((r) => UNASSIGNED(r)).map((r) => r.id);
  if (placeholders.length) await admin.from('user_roles').delete().eq('user_id', userId).in('role_id', placeholders);
  const { error } = await admin.from('user_roles').insert({ user_id: userId, role_id: role.id, assigned_by: approverId });
  if (error) return { ok: false, error: 'Could not assign the role' };

  await notify(admin, [userId], {
    type: 'account_approved', title: 'Your account was approved',
    message: `You now have the ${role.name} role. Welcome aboard!`, link: '/dashboard',
  });
  return { ok: true };
}

export async function rejectUser(admin: Db, userId: string, rejecterId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: target } = await admin.from('user_profiles').select('id, is_client, is_superadmin').eq('id', userId).maybeSingle();
  if (!target || target.is_client || target.is_superadmin) return { ok: false, error: 'User not found' };
  if (userId === rejecterId) return { ok: false, error: 'You cannot reject your own account' };
  const { error: authError } = await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' });
  if (authError) return { ok: false, error: 'Could not block sign-in' };
  const { error } = await admin.from('user_profiles').update({ is_active: false, deactivated_at: new Date().toISOString() }).eq('id', userId);
  return error ? { ok: false, error: 'Could not deactivate the account' } : { ok: true };
}

/** Tell the people who manage roles that someone is waiting. De-duplicated per user and day. */
export async function requestApproval(admin: Db, userId: string, name: string) {
  const { data: rows } = await admin.from('user_roles').select('user_id, roles!user_roles_role_id_fkey(permissions)');
  const managers = new Set<string>();
  for (const r of rows || []) {
    const role = Array.isArray(r.roles) ? r.roles[0] : r.roles;
    if (role?.permissions?.manage_user_roles || role?.permissions?.manage_users) managers.add(r.user_id);
  }
  const { data: admins } = await admin.from('user_profiles').select('id').eq('is_superadmin', true).neq('is_active', false);
  (admins || []).forEach((a: any) => managers.add(a.id));
  const day = new Date().toISOString().slice(0, 10);
  await notify(admin, Array.from(managers), {
    type: 'approval_request', title: 'New user waiting for approval',
    message: `${name} signed up and is waiting for a role`, link: '/admin/users/pending',
    dedupeKey: `signup:${userId}:${day}`,
  });
}
