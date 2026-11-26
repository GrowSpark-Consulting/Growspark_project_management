/**
 * Portal resolution — decides which portal(s) a user can use.
 * Pure functions on an already-loaded profile (works in the browser and on the server).
 * Based on permissions, never on role names.
 */

type AnyProfile = {
  id?: string;
  is_superadmin?: boolean | null;
  is_client?: boolean | null;
  is_active?: boolean | null;
  user_roles?: Array<{ roles?: { name?: string | null; is_system_role?: boolean | null; permissions?: unknown } | null }> | null;
} | null | undefined;

export function profilePermissions(profile: AnyProfile): Set<string> {
  const set = new Set<string>();
  for (const ur of profile?.user_roles || []) {
    const perms = (ur?.roles?.permissions || {}) as Record<string, boolean>;
    for (const [key, value] of Object.entries(perms)) {
      if (value === true) set.add(key);
    }
  }
  return set;
}

export function isSuperadminProfile(profile: AnyProfile): boolean {
  if (!profile) return false;
  if (profile.is_superadmin) return true;
  return (profile.user_roles || []).some(
    (ur) => ur?.roles?.is_system_role === true && (ur.roles.name || '').toLowerCase() === 'superadmin'
  );
}

export function isClientProfile(profile: AnyProfile): boolean {
  return profile?.is_client === true;
}

export function isActiveProfile(profile: AnyProfile): boolean {
  return profile?.is_active !== false;
}

export function hasAssignedRole(profile: AnyProfile): boolean {
  const roles = profile?.user_roles || [];
  if (roles.length === 0) return false;
  if (roles.length === 1) {
    const r = roles[0]?.roles;
    const name = (r?.name || '').toLowerCase();
    if (r?.is_system_role && (name.includes('unassigned') || name === 'no assigned role')) return false;
  }
  return true;
}

export const MANAGER_PERMISSIONS = ['manage_projects', 'manage_all_projects', 'approve_timesheets'] as const;

export function isManagerProfile(profile: AnyProfile): boolean {
  if (!profile || isClientProfile(profile)) return false;
  if (isSuperadminProfile(profile)) return true;
  const perms = profilePermissions(profile);
  return MANAGER_PERMISSIONS.some((p) => perms.has(p));
}

/** Where a user should land after login. */
export function landingPathFor(profile: AnyProfile): string {
  if (!profile) return '/login';
  if (isClientProfile(profile)) return '/client-portal';
  if (isSuperadminProfile(profile)) return '/manager';
  if (!hasAssignedRole(profile)) return '/welcome';
  if (isManagerProfile(profile)) return '/manager';
  return '/dashboard';
}

/**
 * Digits for wa.me (country code first, no +). A 10-digit Indian mobile number typed without the country code
 * (98765 43210, or 098765 43210 with the trunk 0) gets 91; anything longer is taken to include its country code.
 */
export function whatsappDigits(phone?: string | null): string {
  let digits = (phone || '').replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 && /^[6-9]/.test(digits)) digits = `91${digits}`;
  return digits;
}

/** Build a free WhatsApp click-to-chat URL (no WhatsApp Business API needed). */
export function buildWhatsAppUrl(message: string, phone?: string | null): string {
  const digits = whatsappDigits(phone);
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(message)}`;
}
