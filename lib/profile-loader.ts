/**
 * Loads a user's profile with roles (and their departments). Used by /api/me/profile, which runs it on
 * the server as the signed-in user (row-level security applies); the browser no longer queries it.
 */
import { logger } from './debug-logger';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Make sure a signed-in account has its profile row, as the old `on_auth_user_created` trigger on
 * auth.users did (the shared database has no trigger there: sign-in may come from another Supabase
 * project). Same row as the trigger made: id, email, and the name from sign-up (else the email); an
 * existing profile is never changed. Registration and both invitation flows create the profile
 * themselves; this covers self sign-up and accounts that already existed in Auth.
 * `admin` is the server-role client (the row belongs to the user, who has no profile yet to pass RLS).
 */
export async function ensureUserProfile(admin: any, user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null }): Promise<boolean> {
  if (!admin || !user?.id || !user.email) return false;
  const metaName = typeof user.user_metadata?.name === 'string' ? user.user_metadata.name.trim() : '';
  const { error } = await admin
    .from('user_profiles')
    .upsert({ id: user.id, email: user.email, name: metaName || user.email }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) logger.error('Could not create the missing profile', { userId: user.id, code: error.code });
  return !error;
}
/**
 * OPTIMIZED: Get user profile with roles in a SINGLE query
 * This combines what was previously 2-3 separate queries into one
 */
export async function fetchUserProfileOptimized(supabase: any, userId: string) {
  // Single query to get profile with all role data
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select(`
      *,
      user_roles!user_roles_user_id_fkey (
        id,
        role_id,
        assigned_at,
        assigned_by,
        roles!user_roles_role_id_fkey (
          id,
          name,
          department_id,
          permissions,
          is_system_role,
          departments!roles_department_id_fkey (
            id,
            name,
            description
          )
        )
      )
    `)
    .eq('id', userId)
    .single();

  if (error) {
    // Handle relationship ambiguity by falling back to separate queries
    if (error.code === 'PGRST201') {
      return await fetchUserProfileFallback(supabase, userId);
    }
    // Handle no profile found
    if (error.code === 'PGRST116') {
      return null;
    }
    logger.error('Error fetching user profile', {}, error as unknown as Error);
    return null;
  }

  return profile;
}

/**
 * Fallback: Fetch profile and roles separately if join fails
 */
async function fetchUserProfileFallback(supabase: any, userId: string) {
  // Get profile first
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    return null;
  }

  // Get roles separately
  const { data: userRoles, error: rolesError } = await supabase
    .from('user_roles')
    .select(`
      id,
      role_id,
      assigned_at,
      assigned_by,
      roles!user_roles_role_id_fkey (
        id,
        name,
        department_id,
        permissions,
        is_system_role,
        departments!roles_department_id_fkey (
          id,
          name,
          description
        )
      )
    `)
    .eq('user_id', userId);

  if (rolesError) {
    logger.error('Error fetching user roles', {}, rolesError as unknown as Error);
    return { ...profile, user_roles: [] };
  }

  return { ...profile, user_roles: userRoles || [] };
}

