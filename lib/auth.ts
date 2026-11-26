
import { createClientSupabase } from './supabase';
import { UserProfile, UserRole, Role, Department } from './supabase';
import { logger } from './debug-logger';
import { type DirectMembership } from './department-membership';

// Authentication helper functions

/**
 * The API runs on a server that sleeps when idle and needs up to a minute to wake. While it wakes, the
 * frontend answers 502/503/504 (or the request fails outright). That is not an answer about the user, so
 * we wait and ask again instead of treating it as "no profile" (which would sign the person out).
 */
export class ServerUnavailableError extends Error {}
const WAKING_STATUSES = new Set([502, 503, 504]);

async function fetchWhileServerWakes(url: string, init: RequestInit, maxWaitMs = 120000): Promise<Response> {
  const started = Date.now();
  let delay = 2000;
  for (;;) {
    try {
      const response = await fetch(url, init);
      if (!WAKING_STATUSES.has(response.status)) return response;
    } catch {
      // Network error: the server is not reachable yet
    }
    if (Date.now() - started + delay > maxWaitMs) throw new ServerUnavailableError('The server is not responding');
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 1.5), 10000);
  }
}

/**
 * Get the current authenticated user (client-side only)
 * Automatically refreshes session if expired
 * @returns The current user or null if not authenticated
 */
export async function getCurrentUser() {
  try {
    const supabase = createClientSupabase();
    if (!supabase) return null;

    // Try to get user - this will automatically refresh if needed
    const { data: { user }, error } = await supabase.auth.getUser();

    // If error indicates expired session, try to refresh
    if (error && (error.message?.includes('session') || error.message?.includes('token') || error.message?.includes('expired'))) {
      logger.debug('Session expired, attempting refresh...', {});
      try {
        const { data: { session }, error: refreshError } = await supabase.auth.refreshSession();
        if (!refreshError && session?.user) {
          // Refresh succeeded, return the user
          return session.user;
        }
      } catch (refreshErr) {
        logger.error('Error refreshing session', {}, refreshErr as Error);
      }
    }

    if (error || !user) {
      if (error) logger.error('Error getting current user', {}, error as Error);
      return null;
    }

    return user;
  } catch (error: unknown) {
    logger.error('Error in getCurrentUser', {}, error as Error);
    return null;
  }
}

/**
 * Get the current user's profile with roles (client-side only)
 * OPTIMIZED: Uses a single query to fetch profile + roles + permissions
 * This reduces load time from 10+ seconds to ~1 second
 *
 * @returns The user profile with roles or null if not found
 */
export async function getCurrentUserProfile() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return null;
    }

    // Profile with roles and direct department memberships, loaded on the server as the user
    // Waits while the server wakes; a real answer (e.g. 401 not signed in, 404 no profile) comes back as is
    const response = await fetchWhileServerWakes('/api/me/profile', { credentials: 'include', cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const profile = (await response.json())?.data;
    if (!profile) {
      return null;
    }

    // Type the return properly
    return profile as UserProfile & {
      user_roles: (UserRole & {
        roles: Role & {
          departments: Department;
        };
      })[];
      department_members: DirectMembership[];
    };
  } catch (error: unknown) {
    // The server did not wake in time: say so, so the caller keeps the session instead of signing out
    if (error instanceof ServerUnavailableError) throw error;
    logger.error('Error in getCurrentUserProfile', {}, error as Error);
    return null;
  }
}

/**
 * Sign in with email and password
 * @param email - User's email
 * @param password - User's password
 * @returns Auth response with user and session
 */
export async function signInWithEmail(email: string, password: string) {
  try {
    const supabase = createClientSupabase();
    if (!supabase) {
      throw new Error('Supabase not configured');
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      logger.error('Sign in error', {}, error as Error);
      throw error;
    }

    return data;
  } catch (error: unknown) {
    logger.error('Error in signInWithEmail', {}, error as Error);
    throw error;
  }
}

/**
 * Sign up with email and password
 * @param email - User's email
 * @param password - User's password
 * @param name - User's name
 * @returns Auth response with user and session
 */
export async function signUpWithEmail(email: string, password: string, name: string) {
  try {
    const supabase = createClientSupabase();
    if (!supabase) {
      throw new Error('Supabase not configured');
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
        },
        // Use auth callback route for proper token exchange
        emailRedirectTo: `${window.location.origin}/auth/callback?type=signup`,
      },
    });

    if (error) {
      logger.error('Sign up error', {
        message: error.message,
        details: (error as unknown as Record<string, unknown>).details,
        hint: (error as unknown as Record<string, unknown>).hint,
        code: error.code,
      });
      
      // Handle specific Supabase auth errors
      if (error.message?.includes('User already registered') || error.message?.includes('already been registered')) {
        throw new Error('User already registered');
      } else if (error.message?.includes('Password should be at least')) {
        throw new Error('Password should be at least 6 characters long');
      } else if (error.message?.includes('Invalid email')) {
        throw new Error('Please enter a valid email address');
      }
      
      throw new Error('Sign up failed. Please try again.');
    }

    // Check if user was actually created (Supabase doesn't throw error for existing emails)
    if (!data.user) {
      // This is expected behavior for existing emails, not an error
      throw new Error('User already registered');
    }

    // Check if email confirmation is pending
    // When email confirmation is enabled in Supabase, data.user exists but data.session is null
    // This is a SUCCESS case - the user was created but needs to confirm their email
    if (data.user && !data.session) {
      // Return with a flag indicating email confirmation is needed
      return {
        ...data,
        needsEmailConfirmation: true
      };
    }

    // Note: User profile is automatically created by database trigger
    // See scripts/FIX-SIGNUP-RLS.sql for trigger setup
    if (process.env.NODE_ENV === 'development') {
      logger.debug('User created successfully. Profile will be created by database trigger.', {});
    }

    return data;
  } catch (error: unknown) {
    // Only log actual errors, not expected "User already registered" cases
    if (error instanceof Error && error.message === 'User already registered') {
      // This is expected behavior, not an error - just re-throw without logging
      throw error;
    }
    
    // Log actual unexpected errors
    logger.error('Unexpected error in signUpWithEmail', {
      message: error instanceof Error ? error.message : 'Unknown error',
    }, error as Error);
    throw error;
  }
}

/**
 * Sign out the current user
 * @returns Promise that resolves when sign out is complete
 */
export async function signOut() {
  try {
    const supabase = createClientSupabase();
    if (!supabase) {
      throw new Error('Supabase not configured');
    }

    const { error } = await supabase.auth.signOut();
    
    if (error) {
      logger.error('Sign out error', {}, error as Error);
      throw error;
    }
  } catch (error: unknown) {
    logger.error('Error in signOut', {}, error as Error);
    throw error;
  }
}

/**
 * Reset password for a user
 * @param email - User's email
 * @returns Promise that resolves when reset email is sent
 */
export async function resetPassword(email: string) {
  try {
    const supabase = createClientSupabase();
    if (!supabase) {
      throw new Error('Supabase not configured');
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      // Use auth callback route for proper token exchange
      redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
    });

    if (error) {
      logger.error('Password reset error', {}, error as Error);
      throw error;
    }
  } catch (error: unknown) {
    logger.error('Error in resetPassword', {}, error as Error);
    throw error;
  }
}

/**
 * Update user password
 * @param newPassword - New password
 * @returns Promise that resolves when password is updated
 */
export async function updatePassword(newPassword: string) {
  try {
    const supabase = createClientSupabase();
    if (!supabase) {
      throw new Error('Supabase not configured');
    }

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      logger.error('Password update error', {}, error as Error);
      throw error;
    }
  } catch (error: unknown) {
    logger.error('Error in updatePassword', {}, error as Error);
    throw error;
  }
}

/**
 * Check if user is authenticated (client-side only)
 * @returns True if user is authenticated, false otherwise
 */
export async function isAuthenticated(): Promise<boolean> {
  try {
    const user = await getCurrentUser();
    return !!user;
  } catch (error: unknown) {
    logger.error('Error in isAuthenticated', {}, error as Error);
    return false;
  }
}

/**
 * Update user profile information
 * @param profileData - Profile data to update
 * @returns Promise that resolves when profile is updated
 */
export async function updateUserProfile(profileData: {
  name?: string;
  bio?: string;
  skills?: string[];
  phone?: string | null;
}) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      throw new Error('User not authenticated');
    }

    if (process.env.NODE_ENV === 'development') {
      logger.debug('Updating user profile via API', profileData);
    }

    // Call the API endpoint which enforces permission checks
    const response = await fetch('/api/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(profileData),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Failed to update profile' }));
      throw new Error(errorData.error || 'Failed to update profile');
    }

    const data = await response.json();
    if (process.env.NODE_ENV === 'development') {
      logger.debug('User profile updated successfully', {});
    }
    return data.profile;
  } catch (error: unknown) {
    logger.error('Error in updateUserProfile', {}, error as Error);
    throw error;
  }
}

/**
 * Get the current session (client-side only)
 * @returns Current session or null
 */
export async function getCurrentSession() {
  try {
    const supabase = createClientSupabase();
    if (!supabase) return null;

    const { data: { session }, error } = await supabase.auth.getSession();
    
    if (error) {
      logger.error('Error getting session', {}, error as Error);
      return null;
    }

    return session;
  } catch (error: unknown) {
    logger.error('Error in getCurrentSession', {}, error as Error);
    return null;
  }
}
