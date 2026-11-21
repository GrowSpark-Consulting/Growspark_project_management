/**
 * Department membership. A person is in a department when EITHER
 *   - they hold a role that belongs to it (roles.department_id), or
 *   - they were added to it directly (department_members: on invitation, or from the Users page).
 * Every place that decides "who is in this department" uses these helpers, so both ways count.
 * Works in the browser and on the server (pass the Supabase client you have).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type DirectMembership = { department_id: string; departments?: { id: string; name: string } | null };

type ProfileLike = {
  user_roles?: Array<{ roles?: { department_id?: string | null; departments?: { id?: string; name?: string } | null } | null }> | null;
  department_members?: DirectMembership[] | null;
} | null | undefined;

/** Department ids of a loaded profile (roles + direct memberships), without duplicates. */
export function profileDepartmentIds(profile: ProfileLike): string[] {
  const ids = new Set<string>();
  for (const ur of profile?.user_roles || []) if (ur?.roles?.department_id) ids.add(ur.roles.department_id);
  for (const m of profile?.department_members || []) if (m?.department_id) ids.add(m.department_id);
  return [...ids];
}

/** Departments (id + name) of a loaded profile, for menus. */
export function profileDepartments(profile: ProfileLike): Array<{ id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>();
  for (const ur of profile?.user_roles || []) {
    const d = ur?.roles?.departments;
    if (d?.id && d.name && !out.has(d.id)) out.set(d.id, { id: d.id, name: d.name });
  }
  for (const m of profile?.department_members || []) {
    const d = m?.departments;
    if (d?.id && d.name && !out.has(d.id)) out.set(d.id, { id: d.id, name: d.name });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A user's direct memberships. Never throws: if the table is missing (code deployed before the
 * migration) or the query fails, the profile simply has none, so sign-in keeps working.
 */
export async function loadDirectMemberships(supabase: any, userId: string): Promise<DirectMembership[]> {
  try {
    const { data, error } = await supabase
      .from('department_members')
      .select('department_id, departments!department_members_department_id_fkey(id, name)')
      .eq('user_id', userId);
    if (error) return [];
    return (data || []).map((m: any) => ({ department_id: m.department_id, departments: Array.isArray(m.departments) ? m.departments[0] : m.departments }));
  } catch {
    return [];
  }
}

/** Ids of everyone in a department (role-based and direct). */
export async function departmentMemberIds(supabase: any, departmentId: string): Promise<string[]> {
  const ids = new Set<string>();
  const { data: roles } = await supabase.from('roles').select('id').eq('department_id', departmentId);
  const roleIds = (roles || []).map((r: any) => r.id);
  if (roleIds.length) {
    const { data: holders } = await supabase.from('user_roles').select('user_id').in('role_id', roleIds);
    for (const h of holders || []) ids.add(h.user_id);
  }
  const { data: direct, error } = await supabase.from('department_members').select('user_id').eq('department_id', departmentId);
  if (!error) for (const d of direct || []) ids.add(d.user_id);
  return [...ids];
}

/** Whether one person is in a department (role-based or direct). */
export async function isInDepartment(supabase: any, userId: string, departmentId: string): Promise<boolean> {
  const { data: viaRole } = await supabase
    .from('user_roles').select('roles!inner(department_id)')
    .eq('user_id', userId).eq('roles.department_id', departmentId).limit(1);
  if ((viaRole?.length || 0) > 0) return true;
  const { data: direct, error } = await supabase
    .from('department_members').select('user_id')
    .eq('user_id', userId).eq('department_id', departmentId).limit(1);
  return !error && (direct?.length || 0) > 0;
}

/** Everyone in a department with name and email, for "assign to" pickers. */
export async function departmentMemberProfiles(supabase: any, departmentId: string): Promise<Array<{ id: string; name: string; email: string }>> {
  const ids = await departmentMemberIds(supabase, departmentId);
  if (!ids.length) return [];
  const { data } = await supabase.from('user_profiles').select('id, name, email').in('id', ids).order('name');
  return data || [];
}
