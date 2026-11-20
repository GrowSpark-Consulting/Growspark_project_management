/**
 * Who may manage employee invitations.
 *   'all' - role managers (manage_user_roles) and superadmins: every invitation
 *   'own' - managers (manage_projects): invitations they sent themselves
 * The role being invited is limited separately (lib/role-guard.ts: never above the inviter).
 */
import { hasPermission } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function invitationAuthority(user: any, supabase: any): Promise<'all' | 'own' | null> {
  if (await hasPermission(user, Permission.MANAGE_USER_ROLES, undefined, supabase)) return 'all';
  if (await hasPermission(user, Permission.MANAGE_PROJECTS, undefined, supabase)) return 'own';
  return null;
}
