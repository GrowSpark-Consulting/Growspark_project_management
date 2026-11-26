'use client';

import { useAuth } from '@/lib/hooks/useAuth';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isSuperadmin, isUnassigned, hasPermission } from '@/lib/rbac';
import { Permission } from '@/lib/permissions';
import { AccessDeniedPage } from '@/components/access-denied-page';

// Permission checks already passed for the signed-in profile, so returning to a page renders it at once.
// Keyed by the profile object: a refreshed profile (e.g. after a role change) starts with an empty record.
const allowedFor = new WeakMap<object, Set<string>>();
const guardKey = (one?: Permission, any?: Permission[]) => one ?? (any || []).join('|');

interface RoleGuardProps {
  children: React.ReactNode;
  fallbackPath?: string;
  requirePermission?: Permission;
  requireAnyPermission?: Permission[];
  allowUnassigned?: boolean;
  /** When set, shows an inline Access Denied page instead of redirecting */
  accessDeniedMessage?: string;
}

/**
 * RoleGuard component - Permission-based route protection
 * 
 * Protects routes based on permissions rather than role names.
 * 
 * @param children - Content to render if access allowed
 * @param fallbackPath - Redirect path if access denied (default: '/welcome')
 * @param requirePermission - Single required permission
 * @param requireAnyPermission - User needs any of these permissions
 * @param allowUnassigned - Allow unassigned users (default: false)
 */
export function RoleGuard({
  children,
  fallbackPath = '/welcome',
  requirePermission,
  requireAnyPermission,
  allowUnassigned = false,
  accessDeniedMessage,
}: RoleGuardProps) {
  const { user, userProfile, loading, error, retryProfile } = useAuth();
  const router = useRouter();
  // Decide the cases that need no lookup right away, so opening a page does not flash "Loading..."
  const [permissionCheck, setPermissionCheck] = useState<boolean | null>(() => {
    if (loading || !user || !userProfile) return null;
    if (isSuperadmin(userProfile)) return true;
    const unassigned = isUnassigned(userProfile);
    if (unassigned) return allowUnassigned ? true : null;
    if (!requirePermission && !requireAnyPermission) return true;
    return allowedFor.get(userProfile)?.has(guardKey(requirePermission, requireAnyPermission)) ? true : null;
  });
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    if (loading) return;

    async function checkAccess() {
      // No user = redirect to login
      if (!user) {
        router.push('/login');
        return;
      }

      // Wait for profile to load before making permission decisions
      if (!userProfile) {
        return;
      }
      const profile = userProfile;
      const remember = () => {
        const seen = allowedFor.get(profile) ?? new Set<string>();
        seen.add(guardKey(requirePermission, requireAnyPermission));
        allowedFor.set(profile, seen);
      };

      // Superadmin bypasses all checks
      if (isSuperadmin(userProfile)) {
        setPermissionCheck(true);
        return;
      }

      // Check if user is unassigned
      const userIsUnassigned = isUnassigned(userProfile);

      if (userIsUnassigned && !allowUnassigned) {
        if (accessDeniedMessage) { setAccessDenied(true); setPermissionCheck(false); return; }
        router.push(fallbackPath);
        return;
      }

      // If user is unassigned and allowUnassigned is true, allow access without permission checks
      if (userIsUnassigned && allowUnassigned) {
        setPermissionCheck(true);
        return;
      }

      // If no permission required, allow access
      if (!requirePermission && !requireAnyPermission) {
        setPermissionCheck(true);
        return;
      }

      // Check specific permission
      if (requirePermission) {
        const hasAccess = await hasPermission(userProfile, requirePermission);
        if (!hasAccess) {
          if (accessDeniedMessage) { setAccessDenied(true); setPermissionCheck(false); return; }
          router.push(fallbackPath);
          return;
        }
        remember();
        setPermissionCheck(true);
        return;
      }

      // Check any of multiple permissions
      if (requireAnyPermission && requireAnyPermission.length > 0) {
        let hasAnyAccess = false;
        for (const perm of requireAnyPermission) {
          if (await hasPermission(userProfile, perm)) {
            hasAnyAccess = true;
            break;
          }
        }
        
        if (!hasAnyAccess) {
          if (accessDeniedMessage) { setAccessDenied(true); setPermissionCheck(false); return; }
          router.push(fallbackPath);
          return;
        }
        remember();
        setPermissionCheck(true);
        return;
      }

      setPermissionCheck(true);
    }

    void checkAccess();
  }, [user, userProfile, loading, router, fallbackPath, requirePermission, requireAnyPermission, allowUnassigned, accessDeniedMessage]);

  // Signed in, but the profile could not be loaded because the server did not answer: the loading state has
  // ended, so say so (waiting for a profile that is not coming would be a spinner with no end)
  if (!loading && user && !userProfile && error) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center" role="alert">
        <div className="text-center max-w-sm px-4">
          <p className="text-sm font-medium text-gray-900">The server isn't responding</p>
          <p className="mt-1 text-sm text-gray-600">You are still signed in. This page will retry when the connection is back, or you can try now.</p>
          <button type="button" onClick={() => void retryProfile()} className="mt-3 inline-flex h-9 items-center rounded-md bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-800">Try again</button>
        </div>
      </div>
    );
  }

  // Show loading state (but not if access was explicitly denied)
  if (!accessDenied && (loading || !user || !userProfile || permissionCheck === null)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
          <p className="mt-2 text-sm text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Permission check passed, render children
  if (permissionCheck) {
    return <>{children}</>;
  }

  // Permission check failed — show Access Denied inline if configured
  if (accessDenied && accessDeniedMessage) {
    const permName = requirePermission || (requireAnyPermission ? requireAnyPermission.join(' or ') : undefined);
    return (
      <AccessDeniedPage
        description={accessDeniedMessage}
        requiredPermission={permName}
      />
    );
  }

  // Permission check failed (will redirect)
  return null;
}

/**
 * Hook to check if user has a specific permission
 * @param permission - Permission to check
 * @returns Object with hasPermission boolean and loading state
 */
export function usePermissionCheck(permission?: Permission) {
  const { userProfile, loading } = useAuth();
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  
  useEffect(() => {
    if (loading || !userProfile) {
      setHasAccess(null);
      return;
    }

    async function check() {
      if (!permission) {
        setHasAccess(true);
        return;
      }

      if (isSuperadmin(userProfile)) {
        setHasAccess(true);
        return;
      }

      const access = await hasPermission(userProfile, permission);
      setHasAccess(access);
    }

    void check();
  }, [userProfile, loading, permission]);
  
  return {
    hasPermission: hasAccess,
    loading: loading || hasAccess === null,
    userProfile
  };
}

/**
 * Hook to check user's role status
 * @returns Object with role status flags
 */
export function useRoleCheck() {
  const { userProfile, loading } = useAuth();
  
  return {
    isSuperadmin: isSuperadmin(userProfile),
    isUnassigned: isUnassigned(userProfile),
    hasRoles: !isUnassigned(userProfile),
    loading,
    userProfile
  };
}
