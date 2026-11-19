/**
 * In-app notifications (existing `notifications` table).
 * Inserted with the service-role client; users read their own rows (RLS).
 * Failures never break the calling request.
 */
import { logger } from '@/lib/debug-logger';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export interface NotificationInput {
  title: string;
  message: string;
  type?: string;
  link?: string | null;
  projectId?: string | null;
  dedupeKey?: string | null;
}

export async function notify(
  admin: Db,
  userIds: Array<string | null | undefined>,
  n: NotificationInput,
  excludeUserId?: string | null
): Promise<void> {
  try {
    const ids = Array.from(new Set(userIds.filter((id): id is string => !!id && id !== excludeUserId)));
    if (ids.length === 0) return;
    const rows = ids.map((user_id) => ({
      user_id,
      title: n.title.slice(0, 200),
      message: n.message.slice(0, 1000),
      type: n.type || 'info',
      link: n.link || null,
      project_id: n.projectId || null,
      dedupe_key: n.dedupeKey || null,
    }));
    if (n.dedupeKey) {
      for (const row of rows) {
        const { error } = await admin.from('notifications').insert(row);
        if (error && error.code !== '23505') logger.warn('notify insert failed', { error: error.message });
      }
    } else {
      const { error } = await admin.from('notifications').insert(rows);
      if (error) logger.warn('notify insert failed', { error: error.message });
    }
  } catch (error) {
    logger.warn('notify failed', { error: (error as Error).message });
  }
}

/** Project manager(s): PM field, account manager, and team members whose roles have manage_projects. */
export async function getProjectManagerIds(admin: Db, projectId: string): Promise<string[]> {
  const ids = new Set<string>();
  const { data: project } = await admin
    .from('projects').select('assigned_user_id, created_by, account_id').eq('id', projectId).maybeSingle();
  if (!project) return [];
  if (project.assigned_user_id) ids.add(project.assigned_user_id);
  if (project.account_id) {
    const { data: acct } = await admin.from('accounts').select('account_manager_id').eq('id', project.account_id).maybeSingle();
    if (acct?.account_manager_id) ids.add(acct.account_manager_id);
  }
  const memberIds = new Set<string>();
  if (project.created_by) memberIds.add(project.created_by);
  const { data: members } = await admin
    .from('project_assignments').select('user_id').eq('project_id', projectId).is('removed_at', null);
  (members || []).forEach((m: any) => memberIds.add(m.user_id));
  if (memberIds.size) {
    const { data: roles } = await admin
      .from('user_roles').select('user_id, roles!user_roles_role_id_fkey(permissions)').in('user_id', Array.from(memberIds));
    (roles || []).forEach((r: any) => {
      const role = Array.isArray(r.roles) ? r.roles[0] : r.roles;
      const perms = (role?.permissions || {}) as Record<string, boolean>;
      if (perms.manage_projects || perms.manage_all_projects) ids.add(r.user_id);
    });
  }
  return Array.from(ids);
}

export async function getProjectTeamIds(admin: Db, projectId: string): Promise<string[]> {
  const ids = new Set<string>();
  const { data: members } = await admin
    .from('project_assignments').select('user_id').eq('project_id', projectId).is('removed_at', null);
  (members || []).forEach((m: any) => ids.add(m.user_id));
  const { data: project } = await admin.from('projects').select('assigned_user_id').eq('id', projectId).maybeSingle();
  if (project?.assigned_user_id) ids.add(project.assigned_user_id);
  return Array.from(ids);
}

/** Active client users of the project's account (only if the project is shared). */
export async function getProjectClientIds(admin: Db, projectId: string): Promise<string[]> {
  const { data: project } = await admin
    .from('projects').select('account_id, shared_with_client').eq('id', projectId).maybeSingle();
  if (!project?.account_id || project.shared_with_client === false) return [];
  const { data } = await admin
    .from('user_profiles').select('id')
    .eq('is_client', true).eq('client_account_id', project.account_id).neq('is_active', false);
  return (data || []).map((u: any) => u.id);
}
