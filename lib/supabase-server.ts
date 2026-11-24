import { ensureUserProfile } from './profile-loader';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { logger } from './debug-logger';
import { loadDirectMemberships } from './department-membership';
import { withQueryLayer, queryLayerEnabled, userRunner } from './db/query';
import { isFrontendOnly, refuseDataAccess } from './frontend-mode';

// On the frontend-only server (lib/frontend-mode.ts) sign-in still works through Supabase Auth, but a
// data read refuses: without a database there, `.from()` would otherwise go to the Supabase Data API
// of the sign-in project, which is not where the data lives.
function authOnly<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from' || prop === 'rpc' || prop === 'schema' || prop === 'storage') {
        return () => refuseDataAccess(`supabase.${String(prop)}`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// Phase 11: with DATABASE_URL set, `.from()` and `.rpc()` on these clients run through Prisma
// (lib/db/query.ts) instead of the Supabase Data API; Auth and Storage still use Supabase.
// The user's clients run as the signed-in user (row-level security applies); the admin client runs
// as the server, where the service-role key was used before.

// Configure global fetch timeout to prevent connection timeout errors
const FETCH_TIMEOUT = 30000; // 30 seconds

// Get Supabase publishable key
const getSupabasePublishableKey = () => {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
};

// Get the direct Supabase URL for server-side API calls
// On VPS: http://127.0.0.1:54321 (direct, bypassing Nginx)
// On local dev: http://127.0.0.1:54321
const getDirectSupabaseUrl = () => {
  return process.env.SUPABASE_SERVER_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
};

// Get a full HTTP URL for the Supabase client (needed for cookie name consistency)
// If NEXT_PUBLIC_SUPABASE_URL is relative (/supabase), we use the direct URL
// but the cookie names need to match what the browser client uses
const getServerSupabaseUrl = () => {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // If it's a relative URL (Nginx proxy mode), use the direct URL for the server client
  // Cookie names are based on the URL, so we use the direct URL everywhere on the server
  if (publicUrl && publicUrl.startsWith('/')) {
    return process.env.SUPABASE_SERVER_URL || 'http://127.0.0.1:54321';
  }
  return publicUrl || process.env.SUPABASE_SERVER_URL;
};

// Check if Supabase is configured (runtime check)
const isSupabaseConfigured = () => {
  const supabaseUrl = getServerSupabaseUrl();
  const supabasePublishableKey = getSupabasePublishableKey();
  return supabaseUrl && supabasePublishableKey &&
    supabaseUrl !== 'your-supabase-project-url' &&
    supabasePublishableKey !== 'your-supabase-publishable-key';
};

// Server component Supabase client (for use in server components)
export const createServerSupabase = async () => {
  if (!isSupabaseConfigured()) {
    logger.error('Supabase not configured: Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY', {});
    return null;
  }
  const supabaseUrl = getServerSupabaseUrl();
  const supabasePublishableKey = getSupabasePublishableKey();
  const cookieStore = await cookies();
  const client = createServerClient(supabaseUrl!, supabasePublishableKey!, {
    cookieOptions: {
      name: 'sb-project-management-auth',
    },
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: any) {
        try {
          cookieStore.set(name, value, options);
        } catch {
          // Ignore errors in API routes where cookies can't be set
        }
      },
      remove(name: string, options: any) {
        try {
          cookieStore.set(name, '', { ...options, maxAge: 0 });
        } catch {
          // Ignore errors in API routes where cookies can't be removed
        }
      },
    },
    global: {
      fetch: (url, options = {}) => {
        // Add timeout to all fetch requests to prevent hanging connections
        return fetch(url, {
          ...options,
          signal: options.signal || AbortSignal.timeout(FETCH_TIMEOUT),
        });
      },
    },
  });
  if (isFrontendOnly()) return authOnly(client);
  return queryLayerEnabled() ? withQueryLayer(client, userRunner(client.auth)) : client;
};

// API route Supabase client (for use in API routes with NextRequest)
// Note: cookies() from next/headers CANNOT be used in Route Handlers (API routes)
// We must parse cookies from the request headers instead
export const createApiSupabaseClient = (request: NextRequest) => {
  if (!isSupabaseConfigured()) {
    logger.error('Supabase not configured: Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY', {});
    return null;
  }

  const supabaseUrl = getServerSupabaseUrl();
  const supabasePublishableKey = getSupabasePublishableKey();

  // Parse cookies from request header - this is the correct way for Route Handlers
  const cookieHeader = request.headers.get('cookie') || '';
  const parsedCookies: Record<string, string> = {};
  
  // Parse cookie header - simple and reliable parsing
  if (cookieHeader) {
    cookieHeader.split(';').forEach((cookie: any) => {
      const trimmed = cookie.trim();
      if (!trimmed) return;
      
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex > 0) {
        const key = trimmed.substring(0, equalIndex).trim();
        // Get everything after '=' 
        let value = trimmed.substring(equalIndex + 1);
        // Try URL decoding - cookies in headers are often URL encoded
        try {
          // Only decode if it looks URL encoded (contains %)
          if (value.includes('%')) {
            value = decodeURIComponent(value);
          }
        } catch {
          // If decoding fails, use original value
        }
        parsedCookies[key] = value;
      }
    });
  }
  
  // Also check request.cookies as a fallback
  request.cookies.getAll().forEach((cookie: any) => {
    if (!parsedCookies[cookie.name]) {
      parsedCookies[cookie.name] = cookie.value;
    }
  });

  const client = createServerClient(supabaseUrl!, supabasePublishableKey!, {
    cookieOptions: {
      name: 'sb-project-management-auth',
    },
    cookies: {
      get(name: string) {
        // Return the exact cookie value as-is
        return parsedCookies[name];
      },
      set() {
        // Cookies can't be set in API routes during the request
        // They need to be set in the response headers
      },
      remove() {
        // Cookies can't be removed in API routes during the request
      },
    },
    global: {
      fetch: (url, options = {}) => {
        // Add timeout to all fetch requests to prevent hanging connections
        return fetch(url, {
          ...options,
          signal: options.signal || AbortSignal.timeout(FETCH_TIMEOUT),
        });
      },
    },
  });
  if (isFrontendOnly()) return authOnly(client);
  return queryLayerEnabled() ? withQueryLayer(client, userRunner(client.auth)) : client;
};

// Admin client for privileged operations (user creation, setup tokens)
// Uses service role key - NEVER expose to client
export const createAdminSupabaseClient = () => {
  if (isFrontendOnly()) refuseDataAccess('The admin client');
  const url = getServerSupabaseUrl();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  const client = createClient(url, serviceKey);
  return queryLayerEnabled() ? withQueryLayer(client, { kind: 'system' }) : client;
};

// Alias for backwards compatibility
export const createServerSupabaseClient = createServerSupabase;

/**
 * Get user profile from API route supabase client
 * Use this in API routes to get the authenticated user's profile
 */
export async function getUserProfileFromRequest(supabase: ReturnType<typeof createApiSupabaseClient>) {
  if (!supabase) return null;

  // Get current user
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return null;
  }

  // Get user profile (created once if missing, as the old auth.users trigger did)
  const loadProfile = () => supabase.from('user_profiles').select('*').eq('id', user.id).single();
  let { data: profile, error: profileError } = await loadProfile();
  if (profileError?.code === 'PGRST116' && (await ensureUserProfile(createAdminSupabaseClient(), user))) {
    ({ data: profile, error: profileError } = await loadProfile());
  }

  if (profileError || !profile) {
    return null;
  }

  // Fetch user roles separately
  const { data: userRoles } = await supabase
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
    .eq('user_id', user.id);

  return {
    ...profile,
    user_roles: userRoles || [],
    // Departments the user was added to directly (separate query: never blocks the request)
    department_members: await loadDirectMemberships(supabase, user.id),
  };
}
