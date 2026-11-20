/**
 * Role escalation rules for server code that writes with the service role (which the database
 * trigger enforce_role_assignment_rules trusts). Same rules as the trigger:
 *   - only a superadmin hands out system roles (Superadmin, Client, No Assigned Role);
 *   - a non-superadmin can only hand out a role whose granted permissions they hold themselves.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export interface RoleRow {
  id: string;
  name: string;
  is_system_role?: boolean | null;
  permissions?: Record<string, boolean> | null;
}

/** Permissions the actor holds through their roles, and whether they are a superadmin. */
export async function actorAuthority(admin: Db, actorId: string): Promise<{ superadmin: boolean; perms: Set<string> }> {
  const [{ data: profile }, { data: rows }] = await Promise.all([
    admin.from('user_profiles').select('is_superadmin').eq('id', actorId).maybeSingle(),
    admin.from('user_roles').select('roles!user_roles_role_id_fkey(name, is_system_role, permissions)').eq('user_id', actorId),
  ]);
  const perms = new Set<string>();
  let superadmin = !!profile?.is_superadmin;
  for (const r of rows || []) {
    const role = Array.isArray(r.roles) ? r.roles[0] : r.roles;
    if (!role) continue;
    if (role.is_system_role && String(role.name).toLowerCase() === 'superadmin') superadmin = true;
    for (const [k, v] of Object.entries(role.permissions || {})) if (v === true) perms.add(k);
  }
  return { superadmin, perms };
}

/** null when allowed, otherwise the reason. */
export async function roleGrantRefusal(admin: Db, actorId: string, role: RoleRow): Promise<string | null> {
  const { superadmin, perms } = await actorAuthority(admin, actorId);
  if (superadmin) return null;
  if (role.is_system_role) return `Only a superadmin can give someone the ${role.name} role`;
  const missing = Object.entries(role.permissions || {}).filter(([k, v]) => v === true && !perms.has(k)).map(([k]) => k);
  if (missing.length) return `You can't give the ${role.name} role: it includes permissions you don't have (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`;
  return null;
}
